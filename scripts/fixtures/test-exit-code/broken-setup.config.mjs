import { fileURLToPath } from "node:url";

export default {
  test: {
    globalSetup: [
      fileURLToPath(new URL("./broken-setup.mjs", import.meta.url)),
    ],
    dir: fileURLToPath(new URL(".", import.meta.url)),
    globals: true,
  },
};
