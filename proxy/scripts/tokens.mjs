#!/usr/bin/env node
// Issue, list, and revoke Skill Recorder access tokens. Runs with your own AWS
// credentials (the default credential chain) against the stack's tokens table.
//
//   node scripts/tokens.mjs create <user> --table <TokensTableName> [--note "laptop"]
//   node scripts/tokens.mjs list --table <TokensTableName>
//   node scripts/tokens.mjs revoke <user> --table <TokensTableName>
//
// Only a SHA-256 hash of each token is stored. `create` prints the token once;
// hand it to the user, who pastes it into Skill Recorder's AI settings.

import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    table: { type: "string" },
    region: { type: "string" },
    note: { type: "string", default: "" },
  },
});

const [command, user] = positionals;
if (!values.table || !["create", "list", "revoke"].includes(command) || (command !== "list" && !user)) {
  console.error("Usage: tokens.mjs <create|revoke> <user> --table <name> | tokens.mjs list --table <name>");
  process.exit(2);
}

const client = new DynamoDBClient(values.region ? { region: values.region } : {});
const TableName = values.table;

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await client.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

if (command === "create") {
  const token = `srp_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await client.send(
    new PutItemCommand({
      TableName,
      Item: {
        tokenHash: { S: tokenHash },
        user: { S: user },
        createdAt: { S: new Date().toISOString() },
        note: { S: values.note },
        disabled: { BOOL: false },
      },
      ConditionExpression: "attribute_not_exists(tokenHash)",
    }),
  );
  console.log(`Access token for ${user} (shown once; store it securely):\n\n${token}\n`);
} else if (command === "list") {
  for (const item of await scanAll()) {
    const state = item.disabled?.BOOL ? "revoked" : "active";
    console.log(
      [item.user?.S, state, item.createdAt?.S, item.note?.S || "", `${item.tokenHash?.S?.slice(0, 12)}…`].join("\t"),
    );
  }
} else {
  let revoked = 0;
  for (const item of await scanAll()) {
    if (item.user?.S !== user || item.disabled?.BOOL) continue;
    await client.send(
      new UpdateItemCommand({
        TableName,
        Key: { tokenHash: item.tokenHash },
        UpdateExpression: "SET disabled = :true, revokedAt = :now",
        ExpressionAttributeValues: { ":true": { BOOL: true }, ":now": { S: new Date().toISOString() } },
      }),
    );
    revoked++;
  }
  console.log(`Revoked ${revoked} token(s) for ${user}. Running instances stop accepting them within a minute.`);
}
