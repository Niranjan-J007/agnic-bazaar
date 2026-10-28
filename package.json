{
  "name": "bazaar-agnic",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "start": "node --env-file=.env --experimental-strip-types src/index.ts",
    "test": "node --experimental-strip-types --test src/fee.test.ts src/service.test.ts src/http.test.ts src/persist.test.ts src/gobtc.test.ts",
    "check": "tsc --noEmit"
  },
  "dependencies": {
    "pg": "^8.16.3"
  },
  "devDependencies": {
    "@types/node": "^22.19.0",
    "@types/pg": "^8.15.5",
    "typescript": "^5.9.3"
  }
}
