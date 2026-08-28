import { runDemo } from "../src/demo-run.ts";

const stateDir = new URL("../.allowance-demo/", import.meta.url).pathname;

runDemo(stateDir).catch((err) => {
  console.error(err);
  process.exit(1);
});
