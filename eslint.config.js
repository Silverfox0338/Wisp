import tseslint from 'typescript-eslint';

export default [{
  files:['src/**/*.ts'],
  languageOptions:{parser:tseslint.parser,parserOptions:{project:'./tsconfig.json'}},
  rules:{
    'no-eval':'error',
    'no-implied-eval':'error',
    'no-new-func':'error',
    'no-unreachable':'error',
    'valid-typeof':'error'
  }
}];
