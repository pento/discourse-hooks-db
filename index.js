#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const os = require("os");

class DiscourseHooksDB {
  constructor() {
    this.hooksDb = new Map();
    this.workDir = path.join(__dirname, "discourse");
  }

  async run() {
    this.totalStartTime = Date.now();
    console.log("Discourse Hooks DB - Starting analysis...");

    this.setupStartTime = Date.now();
    await this.setupWorkDirectory();
    this.setupEndTime = Date.now();
    console.log(
      `Git setup completed in ${((this.setupEndTime - this.setupStartTime) / 1000).toFixed(2)}s`
    );

    const versions = await this.getDiscourseVersions();

    if (versions.length === 0) {
      console.log("No versions found to analyze");
      return;
    }

    // Use worker threads for parallel processing
    const maxWorkers = Math.min(os.cpus().length, versions.length, 10); // Limit to 10 concurrent downloads
    console.log(
      `Using ${maxWorkers} worker threads for ${versions.length} versions`
    );

    this.analysisStartTime = Date.now();
    const results = await this.processVersionsInParallel(versions, maxWorkers);
    this.analysisEndTime = Date.now();
    console.log(
      `Version analysis completed in ${((this.analysisEndTime - this.analysisStartTime) / 1000).toFixed(2)}s`
    );

    // Merge all results
    results.forEach((hooks) => {
      hooks.forEach((hook) => {
        if (!this.hooksDb.has(hook.name)) {
          this.hooksDb.set(hook.name, {
            name: hook.name,
            type: hook.type,
            firstVersion: hook.version,
            locations: [],
            argumentHistory: new Map(),
          });
        }

        const hookData = this.hooksDb.get(hook.name);

        // Find existing location entry for this version/file combination
        let locationEntry = hookData.locations.find(
          (loc) => loc.version === hook.version && loc.file === hook.file
        );

        if (!locationEntry) {
          locationEntry = {
            version: hook.version,
            file: hook.file,
            lines: [...(hook.lines || [])],
            arguments: hook.arguments || [],
          };
          hookData.locations.push(locationEntry);
        } else {
          // Merge lines from this hook instance
          const newLines = hook.lines || [];
          newLines.forEach((line) => {
            if (!locationEntry.lines.includes(line)) {
              locationEntry.lines.push(line);
            }
          });
          locationEntry.lines.sort((a, b) => a - b); // Keep lines sorted

          // For value transformers and app events, merge arguments within the same version
          // (behavior transformers don't track arguments)
          if (
            hook.type === "value_transformer" ||
            hook.type === "app_event_trigger"
          ) {
            const existingArgs = new Set(locationEntry.arguments);
            const newArgs = hook.arguments || [];
            newArgs.forEach((arg) => {
              if (!existingArgs.has(arg)) {
                locationEntry.arguments.push(arg);
                existingArgs.add(arg);
              }
            });
            // Sort for consistency
            locationEntry.arguments.sort();
          }
        }

        // For now, just track raw arguments - we'll consolidate later
        const argKey = JSON.stringify(hook.arguments || []);
        if (!hookData.argumentHistory.has(argKey)) {
          hookData.argumentHistory.set(argKey, {
            arguments: hook.arguments || [],
            firstSeenVersion: hook.version,
            versions: [],
          });
        }
        hookData.argumentHistory.get(argKey).versions.push(hook.version);
      });
    });

    // Post-process argument history for value transformers and app events
    this.consolidateArgumentHistory();

    await this.generateReport();
  }

  async processVersionsInParallel(versions, maxWorkers) {
    return new Promise((resolve) => {
      const results = [];
      let completed = 0;
      let versionIndex = 0;
      const workers = [];

      const createWorker = () => {
        if (versionIndex >= versions.length) {
          return;
        }

        const version = versions[versionIndex++];
        const worker = new Worker(__filename, {
          workerData: { version, workDir: this.workDir },
        });

        workers.push(worker);

        worker.on("message", (data) => {
          // Handle new message format with timing data
          if (data.hooks && data.timing) {
            results.push(data.hooks);
            completed++;
            const {
              version: completedVersion,
              totalTime,
              gitTime,
              analysisTime,
            } = data.timing;
            console.log(
              `Completed ${completedVersion} (${completed}/${versions.length})`
            );
            console.log(
              `  Time: ${totalTime.toFixed(2)}s (git: ${gitTime.toFixed(2)}s, analysis: ${analysisTime.toFixed(2)}s)`
            );
          } else {
            console.log(data);
          }

          worker.terminate();
          workers.splice(workers.indexOf(worker), 1);

          if (completed === versions.length) {
            resolve(results);
          } else {
            createWorker(); // Start next version
          }
        });

        worker.on("error", (error) => {
          console.error(`Worker error for ${version}:`, error);
          completed++;
          worker.terminate();
          workers.splice(workers.indexOf(worker), 1);

          if (completed === versions.length) {
            resolve(results);
          } else {
            createWorker();
          }
        });
      };

      // Start initial batch of workers
      for (let i = 0; i < maxWorkers && i < versions.length; i++) {
        createWorker();
      }
    });
  }

  async setupWorkDirectory() {
    if (!fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true });
    }

    // Set up main repository for efficient version access
    const mainRepoDir = path.join(this.workDir, ".discourse-main-repo");
    if (!fs.existsSync(mainRepoDir)) {
      console.log("Cloning main Discourse repository...");
      const cloneStartTime = Date.now();
      execSync(
        `git clone --bare https://github.com/discourse/discourse.git ${mainRepoDir}`,
        { stdio: "inherit" }
      );
      const cloneEndTime = Date.now();
      console.log(
        `Repository cloned in ${((cloneEndTime - cloneStartTime) / 1000).toFixed(2)}s`
      );
    } else {
      console.log("Updating main Discourse repository...");
      const fetchStartTime = Date.now();
      execSync(`cd ${mainRepoDir} && git fetch --all --tags`, {
        stdio: "pipe",
      });
      const fetchEndTime = Date.now();
      console.log(
        `Repository updated in ${((fetchEndTime - fetchStartTime) / 1000).toFixed(2)}s`
      );
    }
  }

  async getDiscourseVersions() {
    // Get all Discourse tags from GitHub
    try {
      const tags = execSync(
        "git ls-remote --tags https://github.com/discourse/discourse.git",
        { encoding: "utf8" }
      );
      const versions = tags
        .split("\n")
        .filter((line) => line.includes("refs/tags/v") && !line.includes("^{}"))
        .map((line) => line.split("refs/tags/")[1])
        .filter((tag) => tag && tag.match(/^v\d+\.\d+\.\d+$/))
        .sort((a, b) => this.compareVersions(a, b));

      // Add "main" as the latest version
      versions.push("main");

      return versions;
    } catch (error) {
      console.error("Error fetching versions:", error.message);
      return [];
    }
  }

  compareVersions(a, b) {
    // Handle "main" as the latest version
    if (a === "main" && b === "main") {
      return 0;
    }
    if (a === "main") {
      return 1; // main is greater than any version
    }
    if (b === "main") {
      return -1; // any version is less than main
    }

    const parseVersion = (v) => v.replace("v", "").split(".").map(Number);
    const [aMajor, aMinor, aPatch] = parseVersion(a);
    const [bMajor, bMinor, bPatch] = parseVersion(b);

    if (aMajor !== bMajor) {
      return aMajor - bMajor;
    }
    if (aMinor !== bMinor) {
      return aMinor - bMinor;
    }
    return aPatch - bPatch;
  }

  consolidateArgumentHistory() {
    // Post-process argument history for value transformers and app events
    this.hooksDb.forEach((hookData) => {
      if (
        hookData.type !== "value_transformer" &&
        hookData.type !== "app_event_trigger"
      ) {
        return; // Skip other hook types (behavior_transformer doesn't track arguments)
      }

      // Get all unique versions for this hook
      const allVersions = new Set();
      hookData.argumentHistory.forEach((history) => {
        history.versions.forEach((version) => allVersions.add(version));
      });

      // Create new consolidated argument history
      const consolidatedHistory = new Map();

      Array.from(allVersions).forEach((version) => {
        // Consolidate arguments for this version
        const consolidatedArgs = this.consolidateArgumentsForVersion(
          hookData,
          version
        );
        const argKey = JSON.stringify(consolidatedArgs);

        if (!consolidatedHistory.has(argKey)) {
          consolidatedHistory.set(argKey, {
            arguments: consolidatedArgs,
            firstSeenVersion: version,
            versions: [],
          });
        }

        // Only add the version once (avoid duplicates)
        if (!consolidatedHistory.get(argKey).versions.includes(version)) {
          consolidatedHistory.get(argKey).versions.push(version);
        }
      });

      // Replace the original argument history with consolidated one
      hookData.argumentHistory = consolidatedHistory;
    });
  }

  consolidateArgumentsForVersion(hookData, version) {
    // Collect all argument arrays for this hook in this version
    const allArgumentArrays = [];

    hookData.locations
      .filter((loc) => loc.version === version)
      .forEach((loc) => {
        if (loc.arguments && loc.arguments.length > 0) {
          allArgumentArrays.push(loc.arguments);
        }
      });

    if (allArgumentArrays.length === 0) {
      return [];
    }

    // Find the maximum number of arguments across all instances
    const maxArgLength = Math.max(
      ...allArgumentArrays.map((args) => args.length)
    );

    // Consolidate arguments by position
    const consolidatedArgs = [];

    for (let i = 0; i < maxArgLength; i++) {
      const argumentsAtPosition = allArgumentArrays
        .filter((args) => i < args.length)
        .map((args) => args[i]);

      const bestName = this.chooseBestArgumentName(argumentsAtPosition);
      consolidatedArgs.push(bestName);
    }

    return consolidatedArgs;
  }

  chooseBestArgumentName(argumentGroup) {
    // Priority 1: Plain variable names
    for (const arg of argumentGroup) {
      if (this.isPlainVariableName(arg)) {
        return arg;
      }
    }

    // Priority 2: Method or member calls - extract the method/member name
    for (const arg of argumentGroup) {
      const extracted = this.extractMethodOrMemberName(arg);
      if (extracted) {
        return extracted;
      }
    }

    // Priority 3: Use "value" as fallback
    return "value";
  }

  isPlainVariableName(arg) {
    // Check if it's a simple variable name (letters, numbers, underscore only)
    return (
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(arg) &&
      ![
        "string",
        "number",
        "boolean",
        "null",
        "array",
        "object",
        "this",
      ].includes(arg)
    );
  }

  extractMethodOrMemberName(arg) {
    // Extract method name from method calls like "bookmark.attachedTo()"
    const methodMatch = arg.match(/\.([a-zA-Z_][a-zA-Z0-9_]*)\(\)/);
    if (methodMatch) {
      return methodMatch[1];
    }

    // Extract member name from member access like "user.username"
    const memberMatch = arg.match(/\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
    if (memberMatch) {
      return memberMatch[1];
    }

    return null;
  }

  extractCoreArgumentName(arg) {
    // Extract a core name for grouping similar arguments
    const methodName = this.extractMethodOrMemberName(arg);
    if (methodName) {
      return methodName;
    }

    // If it's a plain variable, return it
    if (this.isPlainVariableName(arg)) {
      return arg;
    }

    // For complex expressions, try to extract a meaningful part
    const match = arg.match(/([a-zA-Z_][a-zA-Z0-9_]*)/);
    return match ? match[1] : "value";
  }

  async analyzeHooks(version) {
    const versionDir = path.join(this.workDir, version);
    if (!fs.existsSync(versionDir)) {
      return;
    }

    const hooks = this.findHooks(versionDir);

    hooks.forEach((hook) => {
      if (!this.hooksDb.has(hook.name)) {
        this.hooksDb.set(hook.name, {
          name: hook.name,
          type: hook.type,
          firstVersion: version,
          locations: [],
        });
      }

      const hookData = this.hooksDb.get(hook.name);
      hookData.locations.push({
        version,
        file: hook.file,
        line: hook.line,
      });
    });
  }

  findHooks(dir) {
    const hooks = [];

    const searchPatterns = [
      // Plugin hooks
      {
        pattern: /<PluginOutlet\s+@name=['"]([^'"]+)['"]/,
        type: "plugin_outlet",
      },
      {
        pattern: /{{plugin-outlet\s+name=['"]([^'"]+)['"]/,
        type: "plugin_outlet",
      },
      {
        pattern: /applyValueTransformer\(['"]([^'"]+)['"]/,
        type: "value_transformer",
      },
      {
        pattern: /appEvents\.trigger\(['"]([^'"]+)['"]/,
        type: "app_event_trigger",
      },
      {
        pattern: /applyBehaviorTransformer\(['"]([^'"]+)['"]/,
        type: "behavior_transformer",
      },
    ];

    this.walkDirectory(dir, (filePath) => {
      if (this.shouldAnalyzeFile(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");

        // Handle multi-line patterns by processing the entire content
        this.findMultiLineHooks(content, filePath, dir, hooks);

        // Keep single-line pattern matching for simpler cases
        const lines = content.split("\n");
        lines.forEach((line, index) => {
          searchPatterns.forEach(({ pattern, type }) => {
            const match = line.match(pattern);
            if (match) {
              hooks.push({
                name: match[1] || `${type}_${hooks.length}`,
                type,
                file: path.relative(dir, filePath),
                lines: [index + 1],
              });
            }
          });
        });
      }
    });

    return hooks;
  }

  findMultiLineHooks(content, filePath, dir, hooks) {
    // Multi-line patterns for applyValueTransformer with arguments
    const valueTransformerRegex =
      /applyValueTransformer\s*\(\s*['"]([^'"]+)['"]([^)]*)\)/gs;
    let match;

    while ((match = valueTransformerRegex.exec(content)) !== null) {
      const lines = this.getMatchLines(content, match);
      const args = this.parseArguments(match[2]);
      hooks.push({
        name: match[1],
        type: "value_transformer",
        file: path.relative(dir, filePath),
        lines,
        arguments: args,
      });
    }

    // Multi-line patterns for appEvents.trigger with arguments
    const appEventRegex =
      /appEvents\.trigger\s*\(\s*['"]([^'"]+)['"]([^)]*)\)/gs;

    while ((match = appEventRegex.exec(content)) !== null) {
      const lines = this.getMatchLines(content, match);
      const args = this.parseAppEventArgs(match[2]);
      hooks.push({
        name: match[1],
        type: "app_event_trigger",
        file: path.relative(dir, filePath),
        lines,
        arguments: args,
      });
    }

    // Multi-line patterns for applyBehaviorTransformer (function parameter ignored)
    const behaviorTransformerRegex =
      /applyBehaviorTransformer\s*\(\s*['"]([^'"]+)['"][^)]*\)/gs;

    while ((match = behaviorTransformerRegex.exec(content)) !== null) {
      const lines = this.getMatchLines(content, match);
      hooks.push({
        name: match[1],
        type: "behavior_transformer",
        file: path.relative(dir, filePath),
        lines,
        arguments: [], // No arguments tracked for behavior transformers
      });
    }

    // Multi-line patterns for PluginOutlet components with attributes
    const pluginOutletRegex =
      /<PluginOutlet\s+@name\s*=\s*['"]([^'"]+)['"][^>]*>/gs;

    while ((match = pluginOutletRegex.exec(content)) !== null) {
      const lines = this.getMatchLines(content, match);
      const outletArgs = this.parsePluginOutletArgs(match[0]);
      hooks.push({
        name: match[1],
        type: "plugin_outlet",
        file: path.relative(dir, filePath),
        lines,
        arguments: outletArgs,
      });
    }

    // Multi-line patterns for plugin-outlet helpers with arguments
    const pluginOutletHelperRegex =
      /{{plugin-outlet\s+name\s*=\s*['"]([^'"]+)['"][^}]*}}/gs;

    while ((match = pluginOutletHelperRegex.exec(content)) !== null) {
      const lines = this.getMatchLines(content, match);
      const args = this.parsePluginOutletHelperArgs(match[0]);
      hooks.push({
        name: match[1],
        type: "plugin_outlet",
        file: path.relative(dir, filePath),
        lines,
        arguments: args,
      });
    }
  }

  getMatchLines(content, match) {
    // Get the matched text
    const matchedText = match[0];

    // Find the starting line number
    const beforeMatch = content.substring(0, match.index);
    const startLine = beforeMatch.split("\n").length;

    // Count newlines in the matched text to determine how many lines it spans
    const matchLines = matchedText.split("\n").length;

    // Generate array of all line numbers this match spans
    const lines = [];
    for (let i = 0; i < matchLines; i++) {
      lines.push(startLine + i);
    }

    return lines;
  }

  parseAppEventArgs(argString) {
    if (!argString || argString.trim() === "") {
      return [];
    }

    // Clean up the argument string and remove leading comma
    const cleaned = argString.trim().replace(/^,\s*/, "");
    if (!cleaned) {
      return [];
    }

    // Parse all arguments after the event name
    const args = [];
    let current = "";
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
        current += char;
      } else if (inString && char === stringChar && cleaned[i - 1] !== "\\") {
        inString = false;
        current += char;
      } else if (!inString && (char === "(" || char === "[" || char === "{")) {
        depth++;
        current += char;
      } else if (!inString && (char === ")" || char === "]" || char === "}")) {
        depth--;
        current += char;
      } else if (!inString && char === "," && depth === 0) {
        // Found a top-level argument separator
        if (current.trim()) {
          args.push(this.normalizeAppEventArg(current.trim()));
        }
        current = "";
      } else {
        current += char;
      }
    }

    // Handle the last argument
    if (current.trim()) {
      args.push(this.normalizeAppEventArg(current.trim()));
    }

    return args.sort(); // Sort for consistent comparison
  }

  normalizeAppEventArg(arg) {
    const trimmed = arg.trim();

    // If it's an object literal, extract property names
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const objectContent = trimmed.slice(1, -1);
      const propNames = [];

      // Simple extraction of property names from object
      let current = "";
      let depth = 0;
      let inString = false;
      let stringChar = "";

      for (let i = 0; i < objectContent.length; i++) {
        const char = objectContent[i];

        if (!inString && (char === '"' || char === "'")) {
          inString = true;
          stringChar = char;
        } else if (
          inString &&
          char === stringChar &&
          objectContent[i - 1] !== "\\"
        ) {
          inString = false;
        } else if (
          !inString &&
          (char === "{" || char === "[" || char === "(")
        ) {
          depth++;
        } else if (
          !inString &&
          (char === "}" || char === "]" || char === ")")
        ) {
          depth--;
        } else if (!inString && char === "," && depth === 0) {
          if (current.trim()) {
            const propName = this.extractPropertyName(current.trim());
            if (propName) {
              propNames.push(propName);
            }
          }
          current = "";
          continue;
        }

        current += char;
      }

      // Handle the last property
      if (current.trim()) {
        const propName = this.extractPropertyName(current.trim());
        if (propName) {
          propNames.push(propName);
        }
      }

      return propNames.length > 0
        ? `{${propNames.sort().join(",")}}`
        : "object";
    }

    // For non-object arguments, normalize to a generic type
    if (trimmed.match(/^['"].*['"]$/)) {
      return "string";
    }
    if (trimmed.match(/^\d+$/)) {
      return "number";
    }
    if (trimmed === "true" || trimmed === "false") {
      return "boolean";
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return "array";
    }
    if (trimmed === "null") {
      return "null";
    }

    // For variables or complex expressions, keep the raw form for now
    // We'll do the intelligent inference later during consolidation
    return trimmed;
  }

  extractPropertyName(propString) {
    // Handle shorthand property (just "prop")
    if (propString.match(/^\w+$/)) {
      return propString;
    }

    // Handle full property ("prop: value" or "prop:value")
    const colonMatch = propString.match(/^(\w+)\s*:/);
    if (colonMatch) {
      return colonMatch[1];
    }

    return null;
  }

  parseArguments(argString) {
    if (!argString || argString.trim() === "") {
      return [];
    }

    // Clean up the argument string
    const cleaned = argString.trim().replace(/^,\s*/, "");
    if (!cleaned) {
      return [];
    }

    // Simple argument parsing - could be enhanced for complex cases
    const args = [];
    let current = "";
    let depth = 0;
    let inString = false;
    let stringChar = "";

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (!inString && (char === '"' || char === "'")) {
        inString = true;
        stringChar = char;
        current += char;
      } else if (inString && char === stringChar && cleaned[i - 1] !== "\\") {
        inString = false;
        current += char;
      } else if (!inString && (char === "(" || char === "[" || char === "{")) {
        depth++;
        current += char;
      } else if (!inString && (char === ")" || char === "]" || char === "}")) {
        depth--;
        current += char;
      } else if (!inString && char === "," && depth === 0) {
        if (current.trim()) {
          args.push(this.normalizeArgument(current.trim()));
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      args.push(this.normalizeArgument(current.trim()));
    }

    return args;
  }

  normalizeArgument(arg) {
    // Normalize common argument patterns to focus on structural changes, not value changes
    let normalized = arg;

    // Normalize handlebars hash arguments - extract just the key names
    // @outletArgs={{hash topic=@topic user=@user}} -> @outletArgs={{hash topic user}}
    normalized = normalized.replace(/{{hash\s+([^}]+)}}/g, (_, content) => {
      const keys = content
        .split(/\s+/)
        .map((pair) => {
          const key = pair.split("=")[0];
          return key;
        })
        .join(" ");
      return `{{hash ${keys}}}`;
    });

    // Normalize simple value references - keep the structure but generalize values
    // @topic -> @topic, this.topic -> this.topic, topic -> topic
    // But @outletArgs={{@topic}} -> @outletArgs={{value}}
    normalized = normalized.replace(/{{([^}]+)}}/g, (match, content) => {
      if (content.includes("hash")) {
        return match; // Already handled above
      }
      // Generalize single value expressions
      if (content.match(/^[@\w.]+$/)) {
        return "{{value}}";
      }
      return match;
    });

    // Normalize attribute values in component attributes
    // @attr="string" -> @attr="string", @attr={{value}} -> @attr={{value}}
    normalized = normalized.replace(
      /@(\w+)=(["'])([^"']*)\2/g,
      "@$1=$2string$2"
    );

    return normalized;
  }

  parsePluginOutletArgs(componentString) {
    // Extract @outletArgs content to get the actual outlet arguments (newer versions)
    let outletArgsMatch = componentString.match(
      /@(?:outletArgs|args)\s*=\s*{{([^}]+)}}/s
    );

    if (!outletArgsMatch) {
      return []; // No outlet args found
    }

    const outletArgsContent = outletArgsMatch[1];

    // Handle different hash patterns: hash, lazyHash, etc.
    const hashMatch = outletArgsContent.match(/(?:lazy)?hash\s+([^}]+)/is);
    if (hashMatch) {
      const hashContent = hashMatch[1];
      // Extract argument names from key=value pairs
      const argNames = [];
      const argRegex = /(\w+)\s*=/g;
      let match;

      while ((match = argRegex.exec(hashContent)) !== null) {
        argNames.push(match[1]);
      }

      return argNames.sort(); // Sort for consistent comparison
    }

    return [];
  }

  parsePluginOutletHelperArgs(helperString) {
    // For plugin-outlet helpers, extract arguments from args parameter
    // Example: {{plugin-outlet name="admin-below-plugins-index" args=(hash model=this.getModel)}}
    const argsMatch = helperString.match(/args\s*=\s*\(([^)]+)\)/);

    if (!argsMatch) {
      return []; // No args found
    }

    const argsContent = argsMatch[1];

    // Handle hash patterns
    const hashMatch = argsContent.match(/(?:lazy)?hash\s+([^)]+)/);
    if (hashMatch) {
      const hashContent = hashMatch[1];
      // Extract argument names from key=value pairs
      const argNames = [];
      const argRegex = /(\w+)\s*=/g;
      let match;

      while ((match = argRegex.exec(hashContent)) !== null) {
        argNames.push(match[1]);
      }

      return argNames.sort(); // Sort for consistent comparison
    }

    return [];
  }

  shouldAnalyzeFile(filePath) {
    const ext = path.extname(filePath);
    return (
      [".js", ".hbs", ".gjs", ".ts"].includes(ext) &&
      !filePath.includes("node_modules") &&
      !filePath.includes(".git") &&
      !filePath.includes("test") &&
      !filePath.includes("spec")
    );
  }

  walkDirectory(dir, callback) {
    if (!fs.existsSync(dir)) {
      return;
    }

    const items = fs.readdirSync(dir);

    items.forEach((item) => {
      const fullPath = path.join(dir, item);
      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        this.walkDirectory(fullPath, callback);
      } else {
        callback(fullPath);
      }
    });
  }

  async generateReport() {
    const hooks = Array.from(this.hooksDb.values()).map((hook) => {
      // Convert argumentHistory Map to a serializable format
      const argumentHistoryArray = Array.from(
        hook.argumentHistory.entries()
      ).map(([, data]) => ({
        argumentSignature: data.arguments,
        firstSeenVersion: data.firstSeenVersion,
        versions: data.versions,
        changeCount: data.versions.length,
      }));

      // Detect argument changes
      const hasArgumentChanges = argumentHistoryArray.length > 1;

      return {
        ...hook,
        argumentHistory: argumentHistoryArray,
        hasArgumentChanges,
        argumentChangeCount: argumentHistoryArray.length - 1,
      };
    });

    // Find the most recent version
    const allVersions = new Set();
    hooks.forEach((hook) => {
      hook.locations.forEach((location) => {
        allVersions.add(location.version);
      });
    });

    const sortedVersions = Array.from(allVersions).sort((a, b) =>
      this.compareVersions(a, b)
    );
    const latestVersion = sortedVersions[sortedVersions.length - 1];

    // Calculate stats for latest version
    const hooksInLatestVersion = hooks.filter((hook) =>
      hook.locations.some((loc) => loc.version === latestVersion)
    );

    // Calculate retired hooks (hooks that don't exist in the latest version)
    const retiredHooks = hooks.filter(
      (hook) => !hook.locations.some((loc) => loc.version === latestVersion)
    );

    // Calculate latest version stats by type
    const latestVersionHooksByType = {};
    hooksInLatestVersion.forEach((hook) => {
      latestVersionHooksByType[hook.type] =
        (latestVersionHooksByType[hook.type] || 0) + 1;
    });

    const report = {
      totalHooks: this.hooksDb.size,
      hooksByType: {},
      hooksWithArgumentChanges: hooksInLatestVersion.filter(
        (h) => h.hasArgumentChanges
      ).length,
      latestVersion,
      hooksInLatestVersion: hooksInLatestVersion.length,
      latestVersionHooksByType,
      retiredHooks: retiredHooks.length,
      lastUpdated: new Date().toISOString(),
      hooks,
      summary: {
        totalArgumentChanges: hooksInLatestVersion.reduce(
          (sum, hook) => sum + hook.argumentChangeCount,
          0
        ),
        hooksWithMostChanges: hooksInLatestVersion
          .filter((h) => h.argumentChangeCount > 0)
          .sort((a, b) => b.argumentChangeCount - a.argumentChangeCount)
          .slice(0, 10)
          .map((h) => ({
            name: h.name,
            type: h.type,
            changes: h.argumentChangeCount,
          })),
        retiredHooksList: retiredHooks.slice(0, 10).map((h) => ({
          name: h.name,
          type: h.type,
          lastSeenVersion: h.locations
            .map((loc) => loc.version)
            .sort((a, b) => this.compareVersions(a, b))
            .pop(),
        })),
      },
    };

    this.hooksDb.forEach((hook) => {
      report.hooksByType[hook.type] = (report.hooksByType[hook.type] || 0) + 1;
    });

    const reportPath = path.join(__dirname, "hooks-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log("\n=== Discourse Hooks Analysis Complete ===");
    console.log(`Total hooks found: ${report.totalHooks}`);
    console.log(
      `Hooks with argument changes: ${report.hooksWithArgumentChanges}`
    );
    console.log(
      `Total argument changes across versions: ${report.summary.totalArgumentChanges}`
    );

    console.log(`\n=== Latest Version Stats (${report.latestVersion}) ===`);
    console.log(`Hooks in latest version: ${report.hooksInLatestVersion}`);
    console.log(`Retired hooks: ${report.retiredHooks}`);

    console.log("\nHooks by type (all versions):");
    Object.entries(report.hooksByType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    console.log(`\nHooks by type (${report.latestVersion}):`);
    Object.entries(report.latestVersionHooksByType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    if (report.summary.hooksWithMostChanges.length > 0) {
      console.log("\nHooks with most argument changes:");
      report.summary.hooksWithMostChanges.forEach((hook) => {
        console.log(`  ${hook.name} (${hook.type}): ${hook.changes} changes`);
      });
    }

    if (report.summary.retiredHooksList.length > 0) {
      console.log("\nRecently retired hooks:");
      report.summary.retiredHooksList.forEach((hook) => {
        console.log(
          `  ${hook.name} (${hook.type}) - last seen in ${hook.lastSeenVersion}`
        );
      });
    }

    console.log(`\nDetailed report saved to: ${reportPath}`);

    const totalEndTime = Date.now();
    const totalTime = (totalEndTime - this.totalStartTime) / 1000;
    const setupTime = (this.setupEndTime - this.setupStartTime) / 1000;
    const analysisTime = (this.analysisEndTime - this.analysisStartTime) / 1000;
    const reportTime = totalTime - setupTime - analysisTime;

    console.log(`\n=== Performance Summary ===`);
    console.log(`Total runtime: ${totalTime.toFixed(2)}s`);
    console.log(
      `  Git setup: ${setupTime.toFixed(2)}s (${((setupTime / totalTime) * 100).toFixed(1)}%)`
    );
    console.log(
      `  Version analysis: ${analysisTime.toFixed(2)}s (${((analysisTime / totalTime) * 100).toFixed(1)}%)`
    );
    console.log(
      `  Report generation: ${reportTime.toFixed(2)}s (${((reportTime / totalTime) * 100).toFixed(1)}%)`
    );
  }
}

// Worker thread logic
if (!isMainThread) {
  const { version, workDir } = workerData;

  async function processVersion() {
    try {
      const workerStartTime = Date.now();
      console.log(`Worker processing ${version}...`);

      // Set up version directory using git worktree
      const versionDir = path.join(workDir, version);
      const mainRepoDir = path.join(workDir, ".discourse-main-repo");

      const gitStartTime = Date.now();

      if (version === "main") {
        // For main branch, re-extract to get latest changes
        execSync(`rm -rf ${versionDir}`, { stdio: "pipe" });
      }

      if (!fs.existsSync(versionDir)) {
        // Create directory and extract only the directories we need
        fs.mkdirSync(versionDir, { recursive: true });

        // Extract only key directories that contain hooks
        const dirsToExtract = ["app", "lib", "plugins", "assets/javascripts"];
        for (const dir of dirsToExtract) {
          try {
            execSync(
              `git --git-dir=${mainRepoDir} archive ${version} ${dir} | tar -x -C ${versionDir} 2>/dev/null || true`,
              { stdio: "pipe" }
            );
          } catch {
            // Directory might not exist in this version, continue
          }
        }
      }
      const gitEndTime = Date.now();

      // Analyze hooks
      const analyzer = new DiscourseHooksDB();
      const foundHooks = analyzer.findHooks(versionDir);

      // Aggregate hooks by name, type, and file to combine lines
      const hookMap = new Map();

      foundHooks.forEach((hook) => {
        const key = `${hook.name}|${hook.type}|${hook.file}`;

        if (!hookMap.has(key)) {
          hookMap.set(key, {
            name: hook.name,
            type: hook.type,
            file: hook.file,
            lines: [...(hook.lines || [])],
            arguments: hook.arguments || [],
            version,
          });
        } else {
          const existing = hookMap.get(key);
          const newLines = hook.lines || [];
          newLines.forEach((line) => {
            if (!existing.lines.includes(line)) {
              existing.lines.push(line);
            }
          });
          existing.lines.sort((a, b) => a - b);
        }
      });

      const hooks = Array.from(hookMap.values());

      const workerEndTime = Date.now();
      const totalWorkerTime = (workerEndTime - workerStartTime) / 1000;
      const gitTime = (gitEndTime - gitStartTime) / 1000;
      const analysisTime = totalWorkerTime - gitTime;

      // Send timing data back to main thread for consistent logging
      parentPort.postMessage({
        hooks,
        timing: {
          version,
          totalTime: totalWorkerTime,
          gitTime,
          analysisTime,
        },
      });
    } catch (error) {
      console.error(`Error processing ${version}:`, error.message);
      parentPort.postMessage([]);
    }
  }

  processVersion();
} else {
  // Main thread
  if (require.main === module) {
    const app = new DiscourseHooksDB();
    app.run().catch(console.error);
  }
}

module.exports = DiscourseHooksDB;
