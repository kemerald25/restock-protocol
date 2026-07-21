import Mocha from "mocha";
import * as path from "path";

const mocha = new Mocha({
  timeout: 120000,
});

mocha.addFile(path.join(__dirname, "authAndIdentity.test.ts"));
mocha.addFile(path.join(__dirname, "merchantAndRateLimit.test.ts"));
mocha.addFile(path.join(__dirname, "integration.test.ts"));

mocha.run((failures) => {
  process.exit(failures ? 1 : 0);
});
