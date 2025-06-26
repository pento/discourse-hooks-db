#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

class HookDocumentationGenerator {
  constructor() {
    this.workDir = path.join(__dirname, "discourse");
    this.masterDir = path.join(this.workDir, "main");
    this.reportPath = path.join(__dirname, "hooks-report.json");
    this.hooksData = null;
  }

  async run(specificHook = null) {
    console.log("🔧 Hook Documentation Generator");
    console.log("================================");

    // Load hooks report
    if (!this.loadHooksReport()) {
      return;
    }

    // Ensure we have the main branch
    if (!this.ensureMainBranch()) {
      return;
    }

    // Filter hooks if specific hook requested
    const hooksToProcess = this.getHooksToProcess(specificHook);

    if (hooksToProcess.length === 0) {
      console.log(
        specificHook
          ? `❌ Hook '${specificHook}' not found`
          : "❌ No hooks found to process"
      );
      return;
    }

    console.log(`📝 Processing ${hooksToProcess.length} hook(s)...`);

    // Process each hook
    let processedCount = 0;
    let errorCount = 0;

    for (const hook of hooksToProcess) {
      try {
        console.log(`\n🔍 Processing: ${hook.name} (${hook.type})`);
        await this.processHook(hook);
        processedCount++;
        console.log(`✅ Completed: ${hook.name}`);
      } catch (error) {
        console.error(`❌ Error processing ${hook.name}:`, error.message);
        errorCount++;
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   ✅ Successfully processed: ${processedCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);
    console.log(`   📁 Working directory: ${this.masterDir}`);
  }

  loadHooksReport() {
    if (!fs.existsSync(this.reportPath)) {
      console.error(`❌ hooks-report.json not found at ${this.reportPath}`);
      console.error("   Please run the analysis first: node index.js");
      return false;
    }

    try {
      const reportData = JSON.parse(fs.readFileSync(this.reportPath, "utf8"));
      this.hooksData = reportData.hooks;
      console.log(`📄 Loaded ${this.hooksData.length} hooks from report`);
      return true;
    } catch (error) {
      console.error("❌ Error loading hooks report:", error.message);
      return false;
    }
  }

  ensureMainBranch() {
    if (!fs.existsSync(this.masterDir)) {
      console.log("📥 Cloning main branch...");
      try {
        execSync(
          `git clone --depth 1 --branch main https://github.com/discourse/discourse.git ${this.masterDir}`,
          { stdio: "inherit" }
        );
      } catch (error) {
        console.error("❌ Error cloning main branch:", error.message);
        return false;
      }
    } else {
      console.log("🔄 Updating main branch...");
      try {
        execSync(`cd ${this.masterDir} && git pull origin main`, {
          stdio: "inherit",
        });
      } catch (error) {
        console.error("❌ Error updating main branch:", error.message);
        return false;
      }
    }
    return true;
  }

  getHooksToProcess(specificHook) {
    let hooksToProcess = this.hooksData.filter((hook) =>
      hook.locations.some((loc) => loc.version === "main")
    );

    if (specificHook) {
      hooksToProcess = hooksToProcess.filter((hook) =>
        hook.name.includes(specificHook)
      );
    }

    return hooksToProcess;
  }

  async processHook(hook) {
    // Get main branch locations for this hook
    const mainLocations = hook.locations.filter(
      (loc) => loc.version === "main"
    );

    for (const location of mainLocations) {
      const filePath = path.join(this.masterDir, location.file);

      if (!fs.existsSync(filePath)) {
        console.log(`⚠️  File not found: ${location.file}`);
        continue;
      }

      await this.addDocumentationToFile(hook, location, filePath);
    }
  }

  async addDocumentationToFile(hook, location, filePath) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // Find the hook location (use first line if multiple)
    const hookLine = Math.min(...location.lines) - 1; // Convert to 0-based index

    if (hookLine < 0 || hookLine >= lines.length) {
      console.log(
        `⚠️  Invalid line number ${hookLine + 1} in ${location.file}`
      );
      return;
    }

    // Check if documentation already exists
    if (this.hasExistingDocumentation(lines, hookLine, hook.type)) {
      console.log(
        `ℹ️  Documentation already exists for ${hook.name} in ${location.file}`
      );
      return;
    }

    // Generate description using Claude CLI
    const description = await this.generateDescription(hook, location.file);

    // Generate documentation comment
    const docComment = this.generateDocComment(
      hook,
      description,
      location
    ).filter((line) => line.trim() !== ""); // Filter out empty lines

    // Detect indentation from the hook line
    const hookLineContent = lines[hookLine];
    const indentation = hookLineContent.match(/^(\s*)/)[1];

    // Apply indentation to documentation lines
    const indentedDocComment = docComment.map((line) =>
      line.trim() === "" ? "" : indentation + line
    );

    // Insert documentation
    const updatedLines = [...lines];
    updatedLines.splice(hookLine, 0, ...indentedDocComment);

    // Write updated content
    fs.writeFileSync(filePath, updatedLines.join("\n"));

    console.log(`📝 Added documentation to ${location.file}:${hookLine + 1}`);
  }

  hasExistingDocumentation(lines, hookLine, hookType) {
    // Look for existing documentation in the lines before the hook
    const lookbackLines = Math.min(10, hookLine);

    for (let i = hookLine - 1; i >= hookLine - lookbackLines; i--) {
      if (i < 0) {
        break;
      }

      const line = lines[i].trim();

      // Check for JSDoc comments
      if (hookType !== "plugin_outlet" && line.includes("/**")) {
        return true;
      }

      // Check for Handlebars comments
      if (hookType === "plugin_outlet" && line.includes("{{!--")) {
        return true;
      }

      // Check for our specific documentation markers
      if (
        line.includes("@pluginOutlet") ||
        line.includes("@transformer") ||
        line.includes("@appEvent")
      ) {
        return true;
      }
    }

    return false;
  }

  async generateDescription(hook, filePath) {
    try {
      // Check if claude CLI is available
      try {
        execSync("which claude", { stdio: "pipe" });
      } catch {
        console.log(`⚠️  Claude CLI not found, using default description`);
        return this.getDefaultDescription(hook);
      }

      const argumentsInfo =
        hook.argumentHistory?.length > 0
          ? hook.argumentHistory
              .map((h) => h.argumentSignature?.join(", "))
              .filter(Boolean)
              .join(" | ")
          : "None";

      const prompt = `Analyze this Discourse ${hook.type.replace("_", " ")} hook and provide a concise description:

Hook Name: ${hook.name}
Hook Type: ${hook.type}
File Location: discourse-versions/main/${filePath}
Arguments: ${argumentsInfo}

Please provide a brief, technical description of what this hook does and when it's used in Discourse. Keep it under 100 characters if possible.`;

      console.log(`🤖 Generating description with Claude...`);

      // Write prompt to temp file and use claude -p < file approach
      const tempFile = path.join(__dirname, ".temp-prompt.txt");
      fs.writeFileSync(tempFile, prompt);

      try {
        const result = execSync(`claude -p < "${tempFile}"`, {
          encoding: "utf8",
          timeout: 30000, // 30 second timeout
        });

        // Clean up temp file
        fs.unlinkSync(tempFile);

        return result.trim().split("\n")[0]; // Take first line only
      } catch (error) {
        // Clean up temp file even on error
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
        throw error;
      }
    } catch (error) {
      console.log(
        `⚠️  Could not generate description with Claude: ${error.message}`
      );
      return this.getDefaultDescription(hook);
    }
  }

  getDefaultDescription(hook) {
    const typeDescriptions = {
      plugin_outlet: `Plugin outlet for extending the UI`,
      value_transformer: `Value transformer for modifying data`,
      app_event_trigger: `Application event for triggering actions`,
      behavior_transformer: `Behavior transformer for modifying functionality`,
    };

    return typeDescriptions[hook.type] || `${hook.type.replace("_", " ")} hook`;
  }

  generateDocComment(hook, description, location) {
    switch (hook.type) {
      case "plugin_outlet":
        return this.generatePluginOutletDoc(hook, description, location);
      case "value_transformer":
      case "behavior_transformer":
        return this.generateTransformerDoc(hook, description);
      case "app_event_trigger":
        return this.generateAppEventDoc(hook, description);
      default:
        return this.generateGenericDoc(hook, description);
    }
  }

  generatePluginOutletDoc(hook, description, location) {
    let args = location.arguments || [];

    // If location has no arguments, get from the most comprehensive argument history entry
    if (
      args.length === 0 &&
      hook.argumentHistory &&
      hook.argumentHistory.length > 0
    ) {
      // Find the argument history entry with the most arguments
      const bestArgHistory = hook.argumentHistory.reduce((best, current) => {
        const currentArgs = current.argumentSignature || [];
        const bestArgs = best.argumentSignature || [];
        return currentArgs.length > bestArgs.length ? current : best;
      });
      args = bestArgHistory.argumentSignature || [];
    }

    const argsList =
      args.length > 0
        ? args.map((arg) => `  @param {*} ${arg} - ${arg} data`).join("\n")
        : "";

    return [
      "{{!",
      `  @pluginOutlet ${hook.name}`,
      `  @description ${description}`,
      `  @since ${hook.firstVersion}`,
      argsList,
      "}}",
    ];
  }

  generateTransformerDoc(hook, description) {
    const args = this.getTransformerArgs(hook);
    const params =
      args.length > 0
        ? args
            .map((arg) => ` * @param {*} ${arg} - ${arg} parameter`)
            .join("\n")
        : " * @param {*} value - The value to transform";

    return [
      "/**",
      ` * ${description}`,
      " *",
      ` * @since ${hook.firstVersion}`,
      " *",
      params,
      ` * @returns {*} Transformed value`,
      " */",
    ];
  }

  generateAppEventDoc(hook, description) {
    const args = this.getAppEventArgs(hook);
    const params =
      args.length > 0
        ? args.map((arg) => ` * @param {*} ${arg} - ${arg} data`).join("\n")
        : " * @param No parameters";

    return [
      "/**",
      ` * ${description}`,
      " *",
      " * @event",
      params,
      ` * @since ${hook.firstVersion}`,
      " */",
    ];
  }

  generateGenericDoc(hook, description) {
    return [
      "/**",
      ` * ${description}`,
      ` * @since ${hook.firstVersion}`,
      " */",
    ];
  }

  getTransformerArgs(hook) {
    if (!hook.argumentHistory || hook.argumentHistory.length === 0) {
      return ["value"];
    }

    // Get the most recent argument signature
    const latestArgs = hook.argumentHistory[hook.argumentHistory.length - 1];
    return latestArgs.argumentSignature || ["value"];
  }

  getAppEventArgs(hook) {
    if (!hook.argumentHistory || hook.argumentHistory.length === 0) {
      return [];
    }

    // Get the most recent argument signature
    const latestArgs = hook.argumentHistory[hook.argumentHistory.length - 1];
    return latestArgs.argumentSignature || [];
  }
}

// CLI interface
if (require.main === module) {
  const specificHook = process.argv[2];

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
🔧 Hook Documentation Generator

Usage:
  node generate-docs.js [hook-name]

Arguments:
  hook-name    Optional: Generate documentation for hooks containing this name

Examples:
  node generate-docs.js                    # Generate docs for all hooks
  node generate-docs.js user-profile       # Generate docs for hooks containing "user-profile"
  node generate-docs.js topic-list-item    # Generate docs for specific hook

Options:
  --help, -h   Show this help message

Notes:
  - Only applies documentation to the main branch
  - Requires hooks-report.json (run analysis first)
  - Uses Claude CLI for generating descriptions
  - Skips hooks that already have documentation
`);
    process.exit(0);
  }

  const generator = new HookDocumentationGenerator();
  generator.run(specificHook).catch(console.error);
}

module.exports = HookDocumentationGenerator;
