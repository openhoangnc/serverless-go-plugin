const util = require("util");
const exec = util.promisify(require("child_process").exec);
const merge = require("lodash.merge");
const pMap = require("p-map");
const os = require("os");
const prettyHrtime = require("pretty-hrtime");
const path = require("path");

const CmdBuildAmd64 = 'GOOS=linux GOARCH=amd64 go build -ldflags="-s -w"';
const CmdBuildArm64 = 'GOOS=linux GOARCH=arm64 go build -ldflags="-s -w"';

const GoRuntime = "go1.x";
const LinuxRuntime = "provided.al2";
const GoRuntimePrefix = "go";

const DefaultConfig = {
  baseDir: ".",
  binDir: ".bin",
  cgo: 0,
  cmd: CmdBuildAmd64,
  monorepo: false,
  runtime: GoRuntime,
};

module.exports = class Plugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.isInvoking = false;

    this.hooks = {
      "before:deploy:function:packageFunction": this.compileFunction.bind(this),
      "before:package:createDeploymentArtifacts": this.compileFunctions.bind(
        this
      ),
      // Because of https://github.com/serverless/serverless/blob/master/lib/plugins/aws/invokeLocal/index.js#L361
      // plugin needs to compile a function and then ignore packaging.
      "before:invoke:local:invoke": this.compileFunctionAndIgnorePackage.bind(
        this
      ),
      "go:build:build": this.goBuild.bind(this),
    };

    this.commands = {
      go: {
        usage: "Manage Go functions",
        lifecycleEvents: ["go"],
        commands: {
          build: {
            usage: "Build Go functions",
            lifecycleEvents: ["build"],
            options: {
              // Define the '--function' option with the '-f' shortcut
              function: {
                usage:
                  'Specify the function you want to build (e.g. "--function myFunction")',
                shortcut: "f",
                required: false,
                type: "string",
              },
            },
          },
        },
      },
    };
  }

  async compileFunction() {
    const name = this.options.function;
    const func = this.serverless.service.functions[this.options.function];

    const timeStart = process.hrtime();
    await this.compile(name, func);
    const timeEnd = process.hrtime(timeStart);

    this.serverless.cli.log(
      `Go Plugin: Compilation time (${name}): ${prettyHrtime(timeEnd)}`
    );
  }

  async compileFunctions() {
    if (this.isInvoking) {
      return;
    }

    let names = Object.keys(this.serverless.service.functions);

    const timeStart = process.hrtime();
    await pMap(
      names,
      async (name) => {
        this.serverless.cli.log("Go Plugin: Compile " + name);
        const func = this.serverless.service.functions[name];
        await this.compile(name, func);
      },
      { concurrency: os.cpus().length > 1 ? os.cpus().length - 1 : 1 }
    );
    const timeEnd = process.hrtime(timeStart);

    this.serverless.cli.log(
      "Go Plugin: Compilation time: " + prettyHrtime(timeEnd)
    );
  }

  async goBuild() {
    if (this.options.function) {
      await this.compileFunction();
    } else {
      await this.compileFunctions();
    }
  }

  async compileFunctionAndIgnorePackage() {
    this.isInvoking = true;
    return await this.compileFunction();
  }

  async compile(name, func) {
    const config = this.getConfig(func);
    if (!config) return;

    const absHandler = path.resolve(config.baseDir);
    const absBin = path.resolve(config.binDir);
    let compileBinPath = path.join(path.relative(absHandler, absBin), name); // binPath is based on cwd no baseDir
    let cwd = config.baseDir;
    let handler = func.handler;
    if (config.monorepo) {
      if (func.handler.endsWith(".go")) {
        cwd = path.relative(absHandler, path.dirname(func.handler));
        handler = path.basename(handler);
      } else {
        cwd = path.relative(absHandler, func.handler);
        handler = ".";
      }
      compileBinPath = path.relative(cwd, compileBinPath);
    }
    try {
      const [env, command] = parseCommand(
        `${config.cmd} -o ${compileBinPath} ${handler}`
      );
      await exec(command, {
        cwd: cwd,
        env: Object.assign(
          {},
          process.env,
          { CGO_ENABLED: config.cgo.toString() },
          env
        ),
      });
    } catch (e) {
      this.serverless.cli.log(
        `Go Plugin: Error compiling "${name}" function (cwd: ${cwd}): ${e.message}`
      );
      process.exit(1);
    }

    let binPath = path.join(config.binDir, name);

    if (config.runtime == LinuxRuntime) {
      const fs = require("fs");
      const archiver = require("archiver");

      const zipPath = binPath + ".zip";
      const zipStream = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(zipStream);
      archive.file(binPath, { name: "bootstrap" });
      await archive.finalize();

      this.serverless.service.functions[name].package = {
        individually: true,
        excludeDevDependencies: false,
        artifact: zipPath,
      };
    } else {
      if (process.platform === "win32") {
        binPath = binPath.replace(/\\/g, "/");
      }
      const packageConfig = {
        individually: true,
        excludeDevDependencies: false,
        patterns: ["!./**", binPath],
      };
      if (func.package) {
        if (func.package.include) {
          packageConfig.patterns = packageConfig.patterns.concat(
            func.package.include
          );
        }
        if (func.package.patterns) {
          packageConfig.patterns = packageConfig.patterns.concat(
            func.package.patterns
          );
        }
      }
      this.serverless.service.functions[name].handler = binPath;
      this.serverless.service.functions[name].package = packageConfig;
    }
  }

  getConfig(func) {
    if (!func) func = {};
    const provider = this.serverless.service.provider || {};

    let config = DefaultConfig;

    const runtime = func.runtime || provider.runtime;
    if (
      runtime !== GoRuntime &&
      runtime !== LinuxRuntime &&
      !runtime.startsWith(GoRuntimePrefix)
    ) {
      return;
    }

    config.runtime = runtime;

    const architecture = func.architecture || provider.architecture;
    if (architecture == "arm64") {
      config.cmd = CmdBuildArm64;
    }

    if (this.serverless.service.custom && this.serverless.service.custom.go) {
      config = merge(config, this.serverless.service.custom.go);
    }
    return config;
  }
};

const envSetterRegex = /^(\w+)=('(.*)'|"(.*)"|(.*))/;
function parseCommand(cmd) {
  const args = cmd.split(" ");
  const envSetters = {};
  let command = "";
  for (let i = 0; i < args.length; i++) {
    const match = envSetterRegex.exec(args[i]);
    if (match) {
      let value;
      if (typeof match[3] !== "undefined") {
        value = match[3];
      } else if (typeof match[4] === "undefined") {
        value = match[5];
      } else {
        value = match[4];
      }

      envSetters[match[1]] = value;
    } else {
      command = args.slice(i).join(" ");
      break;
    }
  }

  return [envSetters, command];
}
