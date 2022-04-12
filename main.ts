const core = require('@actions/core');
const cache = require('@actions/cache');
const github = require('@actions/github');
const fs = require('fs');
const glob = require('glob');
const { exec } = require('child_process');

const JAPI_COMPLIANCE_CHECKER_REPO = "https://github.com/lvc/japi-compliance-checker.git";
const JAPI_COMPLIANCE_CHECKER_VERSION = "2.4";
const INSTALL_DIRECTORY = ".japi_compliance_checker";
const EXECUTABLE = "japi-compliance-checker.pl";

async function run() {
    if (!cache.isFeatureAvailable()) {
        core.setFailed("Cache feature unavailable");
        return;
    }

    const context = github.context;
    const event = context.eventName;

    const key = core.getInput("key");
    const file = core.getInput("file");

    const paths = await getPaths(file);
    core.info("Path \"" + file + "\" matched " + paths.length + " file(s)");

    // Rename original files to be -original.jar
    let checkedPaths = [];
    for (let path of paths) {
        if (!path.endsWith(".jar")) {
            core.info("Skipping unexpected file: " + path + " (does not end with .jar)");
            continue;
        }
        let sources;
        if ((sources = path.endsWith("-sources.jar")) || path.endsWith("-javadoc.jar")) {
            core.info("Skipping " + (sources ? "source" : "javadoc") + " file: " + path);
            continue;
        }

        checkedPaths.push(path);
    }

    if (checkedPaths.length === 0) {
        core.setFailed("No valid paths.");
        return;
    }

    let push;
    if ((push = event === "push") || event === "workflow_dispatch" || event === "schedule") {
        // update cache
        const identifier = push ? context.sha : Date.now().toString();
        const cacheKey = key + "-" + identifier;
        core.info("Saving cache: " + cacheKey);
        await cache.saveCache(checkedPaths, cacheKey);
        return;
    } else if (event !== "pull_request") {
        core.setFailed("Unexpected event: " + context);
        return;
    }

    const base = context.payload.pull_request.base;
    const baseRef = base.ref;
    const baseSha = base.sha;

    for (let path of checkedPaths) {
        await rename(path, mapPath(path, baseRef));
    }

    // Restore cache
    const cacheKey = await cache.restoreCache(checkedPaths, key + "-" + baseSha, [key + "-"]);
    if (cacheKey === undefined) {
        core.setFailed("Original not cached");
        return;
    }
    core.info("Cache " + cacheKey + " retrieved");

    // Install japi-compliance-checker
    core.info("Installing japi-compliance-checker");
    try {
        await execute(
            "git clone -c advice.detachedHead=false --depth 1 --branch " + JAPI_COMPLIANCE_CHECKER_VERSION + " " + JAPI_COMPLIANCE_CHECKER_REPO + " " + INSTALL_DIRECTORY + " " +
            "&& cd " + INSTALL_DIRECTORY + " " +
            "&& sudo make install " +
            "&& sudo chmod +x " + EXECUTABLE + " " +
            "&& cd .."
        );
    } catch (e) {
        core.error(e);
        core.setFailed("Failed to install japi-compliance-checker");
        return;
    }

    core.info("japi-compliance-checker install finished");

    let fails = 0;
    for (let path of checkedPaths) {
        let original = mapPath(path, baseRef);

        const command = "./" + INSTALL_DIRECTORY + "/" + EXECUTABLE + " \"" + path + "\" \"" + original + "\"";// TODO: permit parameters
        core.info("Checking " + path);
        core.info("> " + command);
        let output;
        try {
            output = await execute(command);
        } catch (e) {
            core.error("Fail");
            if (e.code) {
                core.error("Reason: " + getErrorCode(e.code));
            }
            fails++;
        }
    }

    if (fails > 0) {
        core.setFailed(fails + " file" + (fails == 1 ? "" : "s") + " failed API compliance checks");
    }
}

function getErrorCode(code) {
    // https://lvc.github.io/japi-compliance-checker/#Error
    switch (code) {
        case 1: return "Incompatible";
        case 2: return "Common error code (program execution failed)";
        case 3: return "A system command was not found (program execution failed)";
        case 4: return "Cannot access input files";
        case 7: return "Invalid input API dump";
        case 8: return "Unsupported version of input API dump";
        case 9: return "Cannot find a module";
        default: return "Unknown exit code " + code;
    }
}

async function getPaths(pattern) : Promise<string[]> {
    return await new Promise((resolve, reject) => {
        glob(pattern, {fs}, (err, files) => {
            if (err) {
                reject(err);
            } else {
                resolve(files);
            }
        });
    });
}

async function execute(command) : Promise<void> {
    return await new Promise((resolve, reject) => {
        let childProcess = exec(command, (err) => {
            if (err) {
                reject(err)
            } else {
                resolve(null);
            }
        });
        childProcess.stdout.on("data", data => {
            if (data) core.info(data)
        });
        childProcess.stderr.on("data", data => {
            if (data) core.info(data)
        });
    });
}

async function rename(oldFile, newFile) : Promise<void> {
    return await new Promise((resolve, reject) => {
        fs.rename(oldFile, newFile, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        })
    })
}

function mapPath(path, ref) : string {
    return path.substring(0, path.length - 4) + "-" + ref + ".jar";
}

// noinspection JSIgnoredPromiseFromCall
run();
