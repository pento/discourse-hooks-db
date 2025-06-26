#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

class WebServer {
  constructor(port = 3001) {
    this.port = port;
    this.webDir = path.join(__dirname, "web");
  }

  start() {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    server.listen(this.port, () => {
      console.log(`\n🚀 Discourse Hooks Database Web UI`);
      console.log(`📍 Server running at: http://localhost:${this.port}`);
      console.log(`📊 Access the web interface to explore hooks data\n`);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `Port ${this.port} is already in use. Trying port ${this.port + 1}...`
        );
        this.port += 1;
        this.start();
      } else {
        console.error("Server error:", err);
      }
    });
  }

  handleRequest(req, res) {
    let filePath = req.url === "/" ? "/index.html" : req.url;

    // Security: prevent directory traversal
    if (filePath.includes("..")) {
      this.send404(res);
      return;
    }

    // Handle hooks report JSON
    if (filePath === "/hooks-report.json") {
      const reportPath = path.join(__dirname, "hooks-report.json");
      if (fs.existsSync(reportPath)) {
        this.serveFile(reportPath, res, "application/json");
      } else {
        this.sendError(
          res,
          404,
          "Hooks report not found. Please run the analysis first."
        );
      }
      return;
    }

    // Serve static files from web directory
    const fullPath = path.join(this.webDir, filePath);

    if (!fs.existsSync(fullPath)) {
      this.send404(res);
      return;
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      this.send404(res);
      return;
    }

    this.serveFile(fullPath, res);
  }

  serveFile(filePath, res, contentType = null) {
    const ext = path.extname(filePath).toLowerCase();

    if (!contentType) {
      const mimeTypes = {
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      contentType = mimeTypes[ext] || "text/plain";
    }

    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      res.end(data);
    } catch (error) {
      console.error("Error serving file:", error);
      this.sendError(res, 500, "Internal server error");
    }
  }

  send404(res) {
    this.sendError(res, 404, "Not Found");
  }

  sendError(res, statusCode, message) {
    res.writeHead(statusCode, { "Content-Type": "text/plain" });
    res.end(message);
  }
}

if (require.main === module) {
  const port = process.argv[2] ? parseInt(process.argv[2], 10) : 3001;
  const server = new WebServer(port);
  server.start();
}

module.exports = WebServer;
