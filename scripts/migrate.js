import { migrate, closeDatabase } from "../lib/db.js";
try {
  await migrate();
  console.log("Glitch Hunt schema is ready.");
} finally {
  await closeDatabase();
}
