import discourseConfigs from "@discourse/lint-configs/eslint";

export default [
  ...discourseConfigs,
  {
    ignores: ["discourse-versions/**/*"],
  },
  {
    rules: {
      "no-console": "off",
    },
  },
];
