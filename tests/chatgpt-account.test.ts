import { expect, test } from "bun:test";
import { assertChatGptAccountIdentity, verifyChatGptAccount } from "../src/chatgpt-account";
import type { Page } from "playwright-core";
const expected = {label:"ALPHA",userId:"user-alpha",accountId:"workspace-alpha"};

test("fixed account requires both user and workspace; labels never establish identity", () => {
  expect(()=>assertChatGptAccountIdentity(expected, expected)).not.toThrow();
  expect(()=>assertChatGptAccountIdentity({}, expected)).toThrow("login required");
  expect(()=>assertChatGptAccountIdentity({...expected,userId:"user-beta"},expected)).toThrow("No prompt was submitted");
  expect(()=>assertChatGptAccountIdentity({...expected,accountId:"workspace-beta"},expected)).toThrow("workspace changed");
});

test("a live login change is detected on the next turn without cached identity", async () => {
  let identity = {...expected};
  const page = {url:()=>"https://chatgpt.com/?temporary-chat=true",evaluate:async()=>identity} as unknown as Page;
  await verifyChatGptAccount(page,expected);
  identity={...identity,userId:"user-beta"};
  await expect(verifyChatGptAccount(page,expected)).rejects.toThrow("account or workspace changed");
  identity={...expected};
  await expect(verifyChatGptAccount(page,expected)).resolves.toBeUndefined();
});

test("network and login failures stop before submission and never expose raw session errors", async () => {
  const page = {url:()=>"https://chatgpt.com/",evaluate:async()=>{throw Error('secret session material');}} as unknown as Page;
  await expect(verifyChatGptAccount(page,expected)).rejects.toThrow("could not verify the current account");
  const loginPage={url:()=>"https://auth.openai.com/",evaluate:async()=>{throw Error('must not fetch');}} as unknown as Page;
  await expect(verifyChatGptAccount(loginPage,expected)).rejects.toThrow("login required");
  try { await verifyChatGptAccount(loginPage,expected); }
  catch(error:any) { expect(error.code).toBe("web_account_verification_required"); expect(error.retryable).toBe(false); expect(error.errorType).toBe("invalid_request_error"); }
});
