# Discourse Hooks Database

A comprehensive analysis tool and web interface for tracking plugin hooks across different versions of Discourse.

## Overview

This project analyzes Discourse source code across multiple versions to identify and track:

- Plugin outlets
- App event triggers
- Value transformers
- Behavior transformers

It provides both a command-line analysis tool and a web interface to explore the data.

## Features

- **Multi-version Analysis**: Processes 229+ Discourse versions from v0.8.0 to current
- **Hook Classification**: Categorizes hooks by type and tracks their evolution
- **Change Tracking**: Identifies when hook arguments change between versions
- **Interactive Web UI**: Browse and search hooks with filtering and sorting
- **Statistics Dashboard**: Overview of hook counts and trends over time
- **GitHub Pages Ready**: Automated deployment to GitHub Pages

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd discourse-hooks-db

# Install dependencies
pnpm install
```

## Usage

### Command Line Analysis

```bash
# Analyze all Discourse versions and generate report
pnpm run analyze

# Same as analyze
pnpm start
```

### Web Interface

```bash
# Start local development server
pnpm run dev

# Or start on default port 8080
pnpm run web
```

### Build for Deployment

```bash
# Generate analysis and prepare web files
pnpm run build
```

## Output

The analysis generates:

- `hooks-report.json`: Complete dataset with all hooks and their details
- Console summary with key statistics
- Web interface data for interactive exploration

## Project Structure

```
├── index.js           # Main analysis script
├── server.js          # Web server for local development
├── generate-docs.js   # Documentation generator
├── web/              # Web interface files
│   ├── index.html    # Main web page
│   ├── app.js        # Frontend JavaScript
│   ├── styles.css    # Styling
│   └── hooks-report.json # Generated data (after build)
├── discourse-versions/ # Discourse source code versions
└── .github/workflows/ # GitHub Actions for deployment
```

## Development

```bash
# Lint code
pnpm run lint

# Fix linting issues
pnpm run lint:fix

# Format code
pnpm run prettier:fix
```

## Deployment

The project is configured for automatic deployment to GitHub Pages:

1. Push changes to the `main` branch
2. GitHub Actions will automatically:
   - Run the analysis
   - Generate the hooks database
   - Deploy to GitHub Pages
