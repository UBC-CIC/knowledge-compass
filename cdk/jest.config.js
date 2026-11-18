module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Prefer .ts sources over stale compiled lib/*.js or bin/*.js left by `tsc`.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  transform: {
    // 151002: hybrid Node16 module kind notice from ts-jest; harmless for tests.
    // tsconfig.jest.json enables isolatedModules (transpile-only) so the suite
    // fits in the CodeBuild heap; `tsc --noEmit` does the type checking.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json', diagnostics: { ignoreCodes: [151002] } }]
  }
};
