// One-off / manual: import Maildoso domains + mailboxes into Replai's DB.
//   node scripts/syncMaildoso.js
require("dotenv").config();
const maildosoService = require("../services/maildoso.service");
const db = require("../config/db.config");

maildosoService
  .syncMailboxes()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error("Maildoso sync failed:", error.message);
    process.exit(1);
  });
