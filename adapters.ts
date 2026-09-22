import {TronWeb} from 'tronweb';
import {Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import * as xrpl from 'xrpl';
import {BlockchainAdapter, ChainTransaction, Network, NetworkHealth, VerificationResult} from './types';

const TRON_RPC = process.env.TRON_NILE_RPC || 'https://nile.trongrid.io';
const SOL_RPC = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com';
const XRPL_RPC = process.env.XRPL_TESTNET_RPC || 'wss://s.altnet.rippletest.net:51233';

export class TronAdapter implements BlockchainAdapter {
  readonly network: Network = 'TRON_NILE';
  private tron = new TronWeb({fullHost: TRON_RPC});
  validateAddress(a:string){ return TronWeb.isAddress(a); }
  async getBalance(a:string){ if(!this.validateAddress(a)) throw new Error('INVALID_TRON_ADDRESS'); return String(await this.tron.trx.getBalance(a)); }
  async verifyMessage(m:string,s:string,a:string){
    if(!this.validateAddress(a)) return false;
    try { return (await this.tron.trx.verifyMessageV2(m,s)) === a; } catch { return false; }
  }
  async buildTransaction(from:string,to:string,amount:string):Promise<ChainTransaction>{
    if(!this.validateAddress(from)||!this.validateAddress(to)) throw new Error('INVALID_TRON_ADDRESS');
    const raw=await this.tron.transactionBuilder.sendTrx(to,Number(amount),from);
    return {network:this.network,from,to,amount,raw,state:'SIGNATURE_PENDING'};
  }
  async broadcastTransaction(signed:unknown){const r=await this.tron.trx.sendRawTransaction(signed as never); if(!r.result)throw new Error(`TRON_BROADCAST_FAILED:${r.code||''}`); return r.txid;}
  async getTransaction(hash:string):Promise<VerificationResult>{
    try { const [tx,info]=await Promise.all([this.tron.trx.getTransaction(hash),this.tron.trx.getTransactionInfo(hash)]); const block=info.blockNumber; const c=(tx.raw_data?.contract?.[0]?.parameter?.value||{}) as {owner_address?:string;to_address?:string;amount?:number}; return {found:!!tx.txID,confirmed:Number.isInteger(block),blockOrLedger:block,success:!info.receipt?.result||info.receipt.result==='SUCCESS',from:c.owner_address?this.tron.address.fromHex(c.owner_address):undefined,to:c.to_address?this.tron.address.fromHex(c.to_address):undefined,amount:c.amount===undefined?undefined:String(c.amount),raw:{tx,info}}; }
    catch(e){return {found:false,confirmed:false,raw:{error:String(e)}};}
  }
  async health():Promise<NetworkHealth>{const started=Date.now(),checkedAt=new Date().toISOString();try{const b=await this.tron.trx.getCurrentBlock();return {network:this.network,rpc:TRON_RPC,healthy:Number.isInteger(b.block_header?.raw_data?.number),height:b.block_header?.raw_data?.number,latencyMs:Date.now()-started,checkedAt};}catch(e){return {network:this.network,rpc:TRON_RPC,healthy:false,latencyMs:Date.now()-started,checkedAt,error:String(e)}}}
}

export class SolanaAdapter implements BlockchainAdapter {
  readonly network: Network='SOLANA_DEVNET';
  private connection=new Connection(SOL_RPC,'confirmed');
  validateAddress(a:string){try{new PublicKey(a);return true;}catch{return false;}}
  async getBalance(a:string){return String(await this.connection.getBalance(new PublicKey(a),'confirmed'));}
  async verifyMessage(m:string,s:string,a:string){try{const sig=s.startsWith('base64:')?Buffer.from(s.slice(7),'base64'):bs58.decode(s);return nacl.sign.detached.verify(Buffer.from(m),sig,new PublicKey(a).toBytes());}catch{return false;}}
  async buildTransaction(from:string,to:string,amount:string):Promise<ChainTransaction>{
    const latest=await this.connection.getLatestBlockhash('confirmed');
    const raw=new Transaction({...latest,feePayer:new PublicKey(from)}).add(SystemProgram.transfer({fromPubkey:new PublicKey(from),toPubkey:new PublicKey(to),lamports:Number(amount)}));
    return {network:this.network,from,to,amount,raw:{transactionBase64:raw.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),...latest},state:'SIGNATURE_PENDING'};
  }
  async broadcastTransaction(signed:unknown){const b=typeof signed==='string'?signed:(signed as {transactionBase64:string}).transactionBase64;return this.connection.sendRawTransaction(Buffer.from(b,'base64'),{skipPreflight:false,maxRetries:3});}
  async getTransaction(hash:string):Promise<VerificationResult>{const [status,tx]=await Promise.all([this.connection.getSignatureStatus(hash,{searchTransactionHistory:true}),this.connection.getParsedTransaction(hash,{commitment:'confirmed',maxSupportedTransactionVersion:0})]);const s=status.value;const i=tx?.transaction.message.instructions.find(x=>'parsed'in x&&x.program==='system'&&(x.parsed as {type?:string}).type==='transfer');const info=i&&'parsed'in i?(i.parsed as {info?:{source?:string;destination?:string;lamports?:number}}).info:undefined;return {found:!!s||!!tx,confirmed:(s?.confirmationStatus==='confirmed'||s?.confirmationStatus==='finalized')&&!s.err,blockOrLedger:tx?.slot,confirmations:s?.confirmations??undefined,success:!s?.err,from:info?.source,to:info?.destination,amount:info?.lamports===undefined?undefined:String(info.lamports),raw:{status:s,tx}};}
  async health():Promise<NetworkHealth>{const started=Date.now(),checkedAt=new Date().toISOString();try{const height=await this.connection.getSlot('confirmed');return {network:this.network,rpc:SOL_RPC,healthy:Number.isInteger(height),height,latencyMs:Date.now()-started,checkedAt};}catch(e){return {network:this.network,rpc:SOL_RPC,healthy:false,latencyMs:Date.now()-started,checkedAt,error:String(e)}}}
}

export class XRPLAdapter implements BlockchainAdapter {
  readonly network: Network='XRPL_TESTNET';
  private client=new xrpl.Client(XRPL_RPC);
  validateAddress(a:string){return xrpl.isValidClassicAddress(a);}
  private async use<T>(fn:(c:xrpl.Client)=>Promise<T>){if(!this.client.isConnected())await this.client.connect();return fn(this.client);}
  async getBalance(a:string){if(!this.validateAddress(a))throw new Error('INVALID_XRPL_ADDRESS');return String(await this.use(c=>c.getXrpBalance(a)));}
  async verifyMessage(m:string,s:string,a:string,publicKey?:string){try{if(!publicKey||xrpl.deriveAddress(publicKey)!==a)return false;return xrpl.verifyKeypairSignature(Buffer.from(m).toString('hex').toUpperCase(),s,publicKey);}catch{return false;}}
  async buildTransaction(from:string,to:string,amount:string):Promise<ChainTransaction>{
    if(!this.validateAddress(from)||!this.validateAddress(to))throw new Error('INVALID_XRPL_ADDRESS');
    const raw=await this.use(c=>c.autofill({TransactionType:'Payment',Account:from,Destination:to,Amount:amount}));
    return {network:this.network,from,to,amount,raw,state:'SIGNATURE_PENDING'};
  }
  async broadcastTransaction(signed:unknown){const blob=typeof signed==='string'?signed:(signed as {tx_blob:string}).tx_blob;const r=await this.use(c=>c.submit(blob));const hash=(r.result.tx_json as {hash?:string}).hash;if(!hash)throw new Error('XRPL_BROADCAST_NO_HASH');return hash;}
  async getTransaction(hash:string):Promise<VerificationResult>{try{const r=await this.use(c=>c.request({command:'tx',transaction:hash,binary:false}));const x=r.result as unknown as {validated?:boolean;ledger_index?:number;Account?:string;Destination?:string;Amount?:string;meta?:{TransactionResult?:string}};return {found:true,confirmed:x.validated===true&&x.meta?.TransactionResult==='tesSUCCESS',success:x.meta?.TransactionResult==='tesSUCCESS',blockOrLedger:x.ledger_index,from:x.Account,to:x.Destination,amount:typeof x.Amount==='string'?x.Amount:undefined,raw:x};}catch(e){return {found:false,confirmed:false,raw:{error:String(e)}};}}
  async health():Promise<NetworkHealth>{const started=Date.now(),checkedAt=new Date().toISOString();try{const r=await this.use(c=>c.request({command:'ledger',ledger_index:'validated'}));const height=r.result.ledger_index;return {network:this.network,rpc:XRPL_RPC,healthy:Number.isInteger(height),height,latencyMs:Date.now()-started,checkedAt};}catch(e){return {network:this.network,rpc:XRPL_RPC,healthy:false,latencyMs:Date.now()-started,checkedAt,error:String(e)}}}
}

export const adapters:Record<Network,BlockchainAdapter>={TRON_NILE:new TronAdapter(),SOLANA_DEVNET:new SolanaAdapter(),XRPL_TESTNET:new XRPLAdapter()};
export const units={TRON_SUN:1_000_000,SOL_LAMPORTS:LAMPORTS_PER_SOL,XRPL_DROPS:1_000_000};
