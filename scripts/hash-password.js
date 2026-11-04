#!/usr/bin/env node
// Prints an ADMIN_PASSWORD_HASH for Railway. Usage: npm run hash-password -- 'your password'
// (or run with no argument and type it in; input is not echoed)
const { hashPassword } = require("../lib/auth");

const out = (pw) => {
  if (!pw || pw.length < 8) { console.error("Password must be at least 8 characters."); process.exit(1); }
  console.log(hashPassword(pw));
};

if (process.argv[2]) out(process.argv[2]);
else {
  process.stdout.write("Password: ");
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  let pw = "";
  stdin.on("data", (d) => {
    for (const c of d.toString("utf8")) {
      if (c === "\r" || c === "\n" || c === "\u0004") { if (stdin.isTTY) stdin.setRawMode(false); process.stdout.write("\n"); out(pw); process.exit(0); }
      else if (c === "\u0003") process.exit(1);
      else if (c === "\u007f") pw = pw.slice(0, -1);
      else pw += c;
    }
  });
}
