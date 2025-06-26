const path = require('path');

module.exports = {
  rootDir: path.resolve(__dirname, '../../../..'),
  testMatch: [
    '<rootDir>/tests/src/**/*.test.js',
  ],
  moduleDirectories:
    ['node_modules',
    "WORKER/Edition/Scripts/nodejs",
      "tests"]
};