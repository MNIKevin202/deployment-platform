import {
  randomBytes,
  scryptSync
} from "node:crypto";
import { stdin, stdout } from "node:process";

function askHiddenPassword(prompt) {
  return new Promise((resolve) => {
    let password = "";

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (character) => {
      if (character === "\u0003") {
        stdout.write("\n");
        process.exit(130);
      }

      if (character === "\r" || character === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        resolve(password);
        return;
      }

      if (character === "\u007f") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          stdout.write("\b \b");
        }

        return;
      }

      password += character;
      stdout.write("*");
    };

    stdin.on("data", onData);
  });
}

const password = await askHiddenPassword("Temporary admin password: ");

if (password.length < 12) {
  console.error("Password must be at least 12 characters.");
  process.exit(1);
}

const confirmation = await askHiddenPassword("Confirm password: ");

if (password !== confirmation) {
  console.error("Passwords do not match.");
  process.exit(1);
}

const salt = randomBytes(32);
const derivedKey = scryptSync(password, salt, 64);

console.log(
  `${salt.toString("hex")}:${derivedKey.toString("hex")}`
);
