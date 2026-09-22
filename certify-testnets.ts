import { writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import {
  Keypair,
  Connection,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { TronWeb } from "tronweb";
import * as xrpl from "xrpl";
import { sign as signKeypair } from "ripple-keypairs";
import { TronAdapter, SolanaAdapter, XRPLAdapter } from "./adapters";
type Evidence = {
  network: string;
  walletConnect: boolean;
  address?: string;
  signature: boolean;
  verify: boolean;
  balance?: string;
  realTestTx: boolean;
  txHash?: string;
  blockOrLedger?: number;
  confirmed: boolean;
  error?: string;
};
const message = (n: string, a: string) =>
  `LOTERIA AUTH\nWallet: ${a}\nNetwork: ${n}\nNonce: ${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}\nTimestamp: ${new Date().toISOString()}`;
async function solana(): Promise<Evidence> {
  const c = new Connection(
      process.env.SOLANA_DEVNET_RPC || "https://api.devnet.solana.com",
      "confirmed",
    ),
    from = Keypair.generate(),
    to = Keypair.generate(),
    a = new SolanaAdapter(),
    m = message("SOLANA_DEVNET", from.publicKey.toBase58()),
    s = bs58.encode(nacl.sign.detached(Buffer.from(m), from.secretKey));
  try {
    const air = await c.requestAirdrop(from.publicKey, LAMPORTS_PER_SOL);
    await c.confirmTransaction(air, "confirmed");
    const balance = await c.getBalance(from.publicKey),
      tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: from.publicKey,
          toPubkey: to.publicKey,
          lamports: 10_000,
        }),
      ),
      hash = await sendAndConfirmTransaction(c, tx, [from], {
        commitment: "confirmed",
      }),
      v = await a.getTransaction(hash);
    return {
      network: "SOLANA_DEVNET",
      walletConnect: true,
      address: from.publicKey.toBase58(),
      signature: true,
      verify: await a.verifyMessage(m, s, from.publicKey.toBase58()),
      balance: String(balance),
      realTestTx: true,
      txHash: hash,
      blockOrLedger: v.blockOrLedger,
      confirmed: v.confirmed,
    };
  } catch (e) {
    return {
      network: "SOLANA_DEVNET",
      walletConnect: true,
      address: from.publicKey.toBase58(),
      signature: true,
      verify: await a.verifyMessage(m, s, from.publicKey.toBase58()),
      realTestTx: false,
      confirmed: false,
      error: String(e),
    };
  }
}
async function xrp(): Promise<Evidence> {
  let c: xrpl.Client | undefined;
  try {
    if (process.env.CERTIFY_XRPL_WS !== "true")
      throw new Error("XRPL_WEBSOCKET_CHECK_REQUIRES_CERTIFY_XRPL_WS=true");
    await lookup("s.altnet.rippletest.net");
    c = new xrpl.Client(
      process.env.XRPL_TESTNET_RPC || "wss://s.altnet.rippletest.net:51233",
    );
    const a = new XRPLAdapter();
    await c.connect();
    const f = await c.fundWallet(),
      d = await c.fundWallet(),
      w = f.wallet,
      m = message("XRPL_TESTNET", w.address),
      sig = signKeypair(
        Buffer.from(m).toString("hex").toUpperCase(),
        w.privateKey,
      ),
      balance = await c.getXrpBalance(w.address),
      prepared = await c.autofill({
        TransactionType: "Payment",
        Account: w.address,
        Destination: d.wallet.address,
        Amount: xrpl.xrpToDrops("1"),
      }),
      signed = w.sign(prepared),
      result = await c.submitAndWait(signed.tx_blob),
      v = await a.getTransaction(signed.hash);
    return {
      network: "XRPL_TESTNET",
      walletConnect: true,
      address: w.address,
      signature: true,
      verify: await a.verifyMessage(m, sig, w.address, w.publicKey),
      balance: String(balance),
      realTestTx: true,
      txHash: signed.hash,
      blockOrLedger: v.blockOrLedger,
      confirmed: v.confirmed && result.result.validated === true,
    };
  } catch (e) {
    return {
      network: "XRPL_TESTNET",
      walletConnect: false,
      signature: false,
      verify: false,
      realTestTx: false,
      confirmed: false,
      error: String(e),
    };
  } finally {
    if (c?.isConnected()) await c.disconnect();
  }
}
async function tron(): Promise<Evidence> {
  const key = process.env.TRON_NILE_TEST_PRIVATE_KEY,
    tw = new TronWeb({
      fullHost: process.env.TRON_NILE_RPC || "https://nile.trongrid.io",
      privateKey: key,
    }),
    a = new TronAdapter(),
    account = key
      ? { address: { base58: tw.defaultAddress.base58 }, privateKey: key }
      : await TronWeb.createAccount(),
    address = account.address.base58 as string,
    m = message("TRON_NILE", address),
    sig = await tw.trx.signMessageV2(m, account.privateKey);
  try {
    const balance = await a.getBalance(address);
    if (!key)
      throw new Error(
        "TRON_NILE_TEST_PRIVATE_KEY_REQUIRED_FOR_FUNDED_TEST_ACCOUNT",
      );
    const dest = (await TronWeb.createAccount()).address.base58 as string,
      u = await a.buildTransaction(address, dest, "1"),
      signed = await tw.trx.sign(u.raw as never, account.privateKey),
      hash = await a.broadcastTransaction(signed);
    let v = await a.getTransaction(hash);
    for (let i = 0; i < 20 && !v.confirmed; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      v = await a.getTransaction(hash);
    }
    return {
      network: "TRON_NILE",
      walletConnect: true,
      address,
      signature: true,
      verify: await a.verifyMessage(m, sig, address),
      balance,
      realTestTx: true,
      txHash: hash,
      blockOrLedger: v.blockOrLedger,
      confirmed: v.confirmed,
    };
  } catch (e) {
    return {
      network: "TRON_NILE",
      walletConnect: true,
      address,
      signature: true,
      verify: await a.verifyMessage(m, sig, address),
      realTestTx: false,
      confirmed: false,
      error: String(e),
    };
  }
}
async function main() {
  const names = ["TRON_NILE", "SOLANA_DEVNET", "XRPL_TESTNET"];
  const settled = await Promise.allSettled([tron(), solana(), xrp()]);
  const evidence = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          network: names[i],
          walletConnect: false,
          signature: false,
          verify: false,
          realTestTx: false,
          confirmed: false,
          error: String(r.reason),
        },
  );
  const out = {
    generatedAt: new Date().toISOString(),
    environment: "OFFICIAL_TEST_NETWORKS",
    evidence,
  };
  writeFileSync("testnet-certification.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
