class DiscourseHooksViewer {
  constructor() {
    this.data = null;
    this.filteredHooks = [];
    this.currentSort = "name";
    this.mostRecentVersion = null;
    this.init();
  }

  async init() {
    await this.loadData();
    this.setupEventListeners();
    this.renderStats();
    this.populateFilters();
    this.setDefaultFilters();
    this.renderChart();
    this.renderHooks();
  }

  async loadData() {
    try {
      const response = await fetch("./hooks-report.json");
      this.data = await response.json();
      this.filteredHooks = [...this.data.hooks];
      this.findMostRecentVersion();
    } catch (error) {
      console.error("Error loading data:", error);
      document.getElementById("hooksGrid").innerHTML =
        '<div class="error">Error loading hooks data. Please ensure the report has been generated.</div>';
    }
  }

  findMostRecentVersion() {
    if (!this.data || !this.data.hooks.length) {
      return;
    }

    // Get all unique versions from all hooks
    const allVersions = new Set();
    this.data.hooks.forEach((hook) => {
      hook.locations.forEach((location) => {
        allVersions.add(location.version);
      });
    });

    // Sort versions to find the most recent
    const sortedVersions = Array.from(allVersions).sort((a, b) => {
      return this.compareVersions(a, b);
    });

    this.mostRecentVersion = sortedVersions[sortedVersions.length - 1];
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

    // Remove 'v' prefix and split into parts
    const parseVersion = (v) => v.replace(/^v/, "").split(".").map(Number);
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

  setupEventListeners() {
    // Search
    document.getElementById("searchInput").addEventListener("input", () => {
      this.applyFilters();
    });

    // Type filter
    document.getElementById("typeFilter").addEventListener("change", () => {
      this.applyFilters();
    });

    // Changes filter
    document.getElementById("changesFilter").addEventListener("change", () => {
      this.applyFilters();
    });

    // Current version filter
    document
      .getElementById("currentVersionFilter")
      .addEventListener("change", () => {
        this.applyFilters();
      });

    // Introduced version filter
    document
      .getElementById("introducedVersionFilter")
      .addEventListener("change", () => {
        this.applyFilters();
      });

    // Reset filters
    document.getElementById("resetFilters").addEventListener("click", () => {
      this.resetFilters();
    });

    // Sort
    document.getElementById("sortBy").addEventListener("change", (e) => {
      this.currentSort = e.target.value;
      this.renderHooks();
    });

    // Modal
    const modal = document.getElementById("hookModal");
    const closeBtn = modal.querySelector(".close");

    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });

    window.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    });

    // Close modal with Esc key
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "block") {
        modal.style.display = "none";
      }
    });
  }

  renderStats() {
    if (!this.data) {
      return;
    }

    document.getElementById("latestVersionHooks").textContent =
      this.data.hooksInLatestVersion;
    document.getElementById("retiredHooks").textContent =
      this.data.retiredHooks;
    document.getElementById("hooksWithChanges").textContent =
      this.data.hooksWithArgumentChanges;
    document.getElementById("totalChanges").textContent =
      this.data.summary.totalArgumentChanges;
    document.getElementById("uniqueTypes").textContent = Object.keys(
      this.data.hooksByType
    ).length;

    // Display last updated timestamp
    if (this.data.lastUpdated) {
      const lastUpdated = new Date(this.data.lastUpdated);
      const formattedDate = lastUpdated.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });
      document.getElementById("lastUpdated").textContent = `Last updated: ${formattedDate}`;
    }
  }

  populateFilters() {
    if (!this.data) {
      return;
    }

    // Populate type filter
    const typeFilter = document.getElementById("typeFilter");
    const types = Object.keys(this.data.hooksByType).sort();

    types.forEach((type) => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type
        .replace(/_/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase());
      typeFilter.appendChild(option);
    });

    // Populate introduced version filter
    const introducedVersionFilter = document.getElementById(
      "introducedVersionFilter"
    );
    const allVersions = new Set();

    this.data.hooks.forEach((hook) => {
      allVersions.add(hook.firstVersion);
    });

    const sortedVersions = Array.from(allVersions).sort((a, b) =>
      this.compareVersions(a, b)
    );

    sortedVersions.forEach((version) => {
      const option = document.createElement("option");
      option.value = version;
      option.textContent = version;
      introducedVersionFilter.appendChild(option);
    });
  }

  setDefaultFilters() {
    if (!this.mostRecentVersion) {
      return;
    }

    // Default to showing only current version hooks
    document.getElementById("currentVersionFilter").checked = true;
    this.applyFilters();
  }

  applyFilters() {
    if (!this.data) {
      return;
    }

    const searchTerm = document
      .getElementById("searchInput")
      .value.toLowerCase();
    const typeFilter = document.getElementById("typeFilter").value;
    const changesOnly = document.getElementById("changesFilter").checked;
    const currentVersionOnly = document.getElementById(
      "currentVersionFilter"
    ).checked;
    const introducedVersionFilter = document.getElementById(
      "introducedVersionFilter"
    ).value;

    this.filteredHooks = this.data.hooks.filter((hook) => {
      // Search filter
      if (searchTerm && !this.matchesSearch(hook, searchTerm)) {
        return false;
      }

      // Type filter
      if (typeFilter && hook.type !== typeFilter) {
        return false;
      }

      // Changes filter
      if (changesOnly && !hook.hasArgumentChanges) {
        return false;
      }

      // Current version filter
      if (currentVersionOnly && !this.isInCurrentVersion(hook)) {
        return false;
      }

      // Introduced version filter
      if (
        introducedVersionFilter &&
        hook.firstVersion !== introducedVersionFilter
      ) {
        return false;
      }

      return true;
    });

    this.renderHooks();
  }

  isInCurrentVersion(hook) {
    if (!this.mostRecentVersion) {
      return true;
    }

    return hook.locations.some(
      (location) => location.version === this.mostRecentVersion
    );
  }

  matchesSearch(hook, searchTerm) {
    return (
      hook.name.toLowerCase().includes(searchTerm) ||
      hook.type.toLowerCase().includes(searchTerm) ||
      hook.locations.some((loc) => loc.file.toLowerCase().includes(searchTerm))
    );
  }

  resetFilters() {
    document.getElementById("searchInput").value = "";
    document.getElementById("typeFilter").value = "";
    document.getElementById("changesFilter").checked = false;
    document.getElementById("currentVersionFilter").checked = true; // Keep current version as default
    document.getElementById("introducedVersionFilter").value = "";
    this.applyFilters();
  }

  sortHooks(hooks) {
    return hooks.sort((a, b) => {
      switch (this.currentSort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "type":
          return a.type.localeCompare(b.type);
        case "firstVersion":
          return a.firstVersion.localeCompare(b.firstVersion);
        case "changes":
          return b.argumentChangeCount - a.argumentChangeCount;
        default:
          return 0;
      }
    });
  }

  renderHooks() {
    if (!this.data) {
      return;
    }

    const hooksGrid = document.getElementById("hooksGrid");
    const sortedHooks = this.sortHooks([...this.filteredHooks]);

    if (sortedHooks.length === 0) {
      hooksGrid.innerHTML =
        '<div class="no-results">No hooks match the current filters.</div>';
      return;
    }

    hooksGrid.innerHTML = sortedHooks
      .map((hook) => this.createHookCard(hook))
      .join("");

    // Add click listeners to hook cards
    hooksGrid.querySelectorAll(".hook-card").forEach((card, index) => {
      card.addEventListener("click", () => {
        this.showHookDetails(sortedHooks[index]);
      });
    });
  }

  getHookTypeClass(hookType) {
    // Convert hook type to CSS class name
    return hookType.replace(/_/g, "-");
  }

  createHookCard(hook) {
    const typeLabel = hook.type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
    const typeClass = this.getHookTypeClass(hook.type);
    const hasChanges = hook.hasArgumentChanges;
    const changesBadge = hasChanges
      ? `<span class="changes-badge">${hook.argumentChangeCount} changes</span>`
      : "";

    return `
      <div class="hook-card ${hasChanges ? "has-changes" : ""}">
        <div class="hook-header">
          <h3 class="hook-name">${hook.name}</h3>
          <span class="hook-type ${typeClass}">${typeLabel}</span>
        </div>
        <div class="hook-meta">
          <span class="first-version">Since: ${hook.firstVersion}</span>
          <span class="locations-count">${hook.locations.length} location${hook.locations.length !== 1 ? "s" : ""}</span>
          ${changesBadge}
        </div>
      </div>
    `;
  }

  showHookDetails(hook) {
    const modal = document.getElementById("hookModal");
    const modalBody = document.getElementById("modalBody");

    const typeLabel = hook.type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
    const typeClass = this.getHookTypeClass(hook.type);

    // Get the latest version this hook appears in
    const latestVersion = this.getLatestVersionForHook(hook);
    const latestLocations = hook.locations.filter(
      (loc) => loc.version === latestVersion
    );

    let argumentsSection = "";
    if (hook.argumentHistory && hook.argumentHistory.length > 0) {
      argumentsSection = `
        <div class="section">
          <h3>Argument History</h3>
          ${hook.argumentHistory
            .map(
              (arg) => `
            <div class="argument-history">
              <div class="argument-signature">
                <strong>Arguments:</strong> ${
                  arg.argumentSignature.length > 0
                    ? arg.argumentSignature
                        .map((a) => `<code>${a}</code>`)
                        .join(", ")
                    : "<em>No arguments</em>"
                }
              </div>
              <div class="argument-meta">
                <span>First seen: ${arg.firstSeenVersion}</span>
                <span>Used in ${arg.versions.length} version${arg.versions.length !== 1 ? "s" : ""}</span>
              </div>
            </div>
          `
            )
            .join("")}
        </div>
      `;
    }

    modalBody.innerHTML = `
      <h2>${hook.name}</h2>
      <div class="hook-type-badge ${typeClass}">${typeLabel}</div>
      
      <div class="section">
        <h3>Overview</h3>
        <p><strong>First introduced:</strong> ${hook.firstVersion}</p>
        <p><strong>Latest version:</strong> ${latestVersion}</p>
        <p><strong>Total historical locations:</strong> ${hook.locations.length}</p>
        <p><strong>Argument changes:</strong> ${hook.argumentChangeCount}</p>
      </div>

      ${argumentsSection}

      <div class="section">
        <h3>Current Locations (${latestVersion})</h3>
        <div class="locations-list">
          ${latestLocations
            .map(
              (loc) => `
            <div class="location-item">
              <div class="location-file">
                <a href="${this.getGitHubUrl(loc.file, loc.lines, latestVersion)}" 
                   target="_blank" rel="noopener noreferrer" class="github-link">
                  ${loc.file}:${this.formatLineNumbers(loc.lines)}
                  <span class="external-link">↗</span>
                </a>
              </div>
              ${
                loc.arguments && loc.arguments.length > 0
                  ? `<div class="location-args">Args: ${loc.arguments.map((a) => `<code>${a}</code>`).join(", ")}</div>`
                  : ""
              }
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `;

    modal.style.display = "block";
  }

  getLatestVersionForHook(hook) {
    const versions = hook.locations.map((loc) => loc.version);
    const uniqueVersions = [...new Set(versions)];

    return uniqueVersions.sort((a, b) => this.compareVersions(a, b))[
      uniqueVersions.length - 1
    ];
  }

  getGitHubUrl(filePath, lines, version) {
    const baseUrl = "https://github.com/discourse/discourse";

    if (!Array.isArray(lines)) {
      lines = [lines];
    }

    if (lines.length === 0) {
      return `${baseUrl}/blob/${version}/${filePath}`;
    }

    if (lines.length === 1) {
      return `${baseUrl}/blob/${version}/${filePath}#L${lines[0]}`;
    }

    // For multiple lines, use GitHub's range syntax
    const sortedLines = [...lines].sort((a, b) => a - b);
    const ranges = this.createLineRanges(sortedLines);

    // GitHub supports highlighting multiple ranges with L1-L5,L10-L15 syntax
    const rangeString = ranges
      .map((range) => {
        if (range.start === range.end) {
          return `L${range.start}`;
        } else {
          return `L${range.start}-L${range.end}`;
        }
      })
      .join(",");

    return `${baseUrl}/blob/${version}/${filePath}#${rangeString}`;
  }

  createLineRanges(sortedLines) {
    if (sortedLines.length === 0) {
      return [];
    }

    const ranges = [];
    let rangeStart = sortedLines[0];
    let rangeEnd = sortedLines[0];

    for (let i = 1; i < sortedLines.length; i++) {
      const currentLine = sortedLines[i];

      // If consecutive line, extend the range
      if (currentLine === rangeEnd + 1) {
        rangeEnd = currentLine;
      } else {
        // Non-consecutive, so finish current range and start new one
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = currentLine;
        rangeEnd = currentLine;
      }
    }

    // Add the final range
    ranges.push({ start: rangeStart, end: rangeEnd });

    return ranges;
  }

  formatLineNumbers(lines) {
    if (!Array.isArray(lines)) {
      return lines.toString();
    }

    if (lines.length === 0) {
      return "";
    }

    if (lines.length === 1) {
      return lines[0].toString();
    }

    // For display, show ranges in a compact format
    const sortedLines = [...lines].sort((a, b) => a - b);
    const ranges = this.createLineRanges(sortedLines);

    return ranges
      .map((range) => {
        if (range.start === range.end) {
          return range.start.toString();
        } else {
          return `${range.start}-${range.end}`;
        }
      })
      .join(", ");
  }

  renderChart() {
    if (!this.data) {
      return;
    }

    // Calculate hooks per version
    const versionHookCounts = new Map();

    this.data.hooks.forEach((hook) => {
      hook.locations.forEach((location) => {
        const version = location.version;
        if (!versionHookCounts.has(version)) {
          versionHookCounts.set(version, new Set());
        }
        versionHookCounts.get(version).add(hook.name);
      });
    });

    // Sort versions chronologically
    const sortedVersions = Array.from(versionHookCounts.keys()).sort((a, b) =>
      this.compareVersions(a, b)
    );

    // Prepare chart data
    const chartData = {
      labels: sortedVersions,
      datasets: [
        {
          label: "Total Hooks",
          data: sortedVersions.map(
            (version) => versionHookCounts.get(version).size
          ),
          borderColor: "#667eea",
          backgroundColor: "rgba(102, 126, 234, 0.1)",
          borderWidth: 3,
          fill: true,
          tension: 0,
          pointBackgroundColor: "#667eea",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 8,
        },
      ],
    };

    const chartConfig = {
      type: "line",
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            mode: "index",
            intersect: false,
            backgroundColor: "rgba(0, 0, 0, 0.8)",
            titleColor: "#fff",
            bodyColor: "#fff",
            borderColor: "#667eea",
            borderWidth: 1,
            callbacks: {
              title: function (context) {
                return `Version ${context[0].label}`;
              },
              label: function (context) {
                return `Total Hooks: ${context.parsed.y}`;
              },
            },
          },
        },
        scales: {
          x: {
            display: true,
            title: {
              display: true,
              text: "Discourse Version",
              color: "#657786",
              font: {
                size: 14,
                weight: "bold",
              },
            },
            ticks: {
              color: "#657786",
              maxTicksLimit: 10,
              callback: function (value, index) {
                const label = this.getLabelForValue(value);
                // Show every other version to avoid crowding
                return index % 2 === 0 ? label : "";
              },
            },
            grid: {
              color: "rgba(0, 0, 0, 0.05)",
            },
          },
          y: {
            display: true,
            title: {
              display: true,
              text: "Number of Hooks",
              color: "#657786",
              font: {
                size: 14,
                weight: "bold",
              },
            },
            ticks: {
              color: "#657786",
              precision: 0,
            },
            beginAtZero: true,
            grid: {
              color: "rgba(0, 0, 0, 0.05)",
            },
          },
        },
        interaction: {
          mode: "nearest",
          axis: "x",
          intersect: false,
        },
        elements: {
          point: {
            hoverBackgroundColor: "#667eea",
            hoverBorderColor: "#fff",
          },
        },
      },
    };

    const ctx = document.getElementById("hooksChart").getContext("2d");
    // eslint-disable-next-line no-new, no-undef
    new Chart(ctx, chartConfig);
  }
}

// Initialize the app when the page loads
document.addEventListener("DOMContentLoaded", () => {
  // eslint-disable-next-line no-new
  new DiscourseHooksViewer();
});
