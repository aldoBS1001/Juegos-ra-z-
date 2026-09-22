import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {adapters} from './adapters';
import {Network,TxState} from './types';

type Challenge={id:string;network:Network;address:string;sessionId:string;nonceHash:Buffer;message:string;expiresAt:number;usedAt?:number};
type TxRecord={id:string;network:Network;from:string;to:string;amount:string;state:TxState;hash?:string;createdAt:string;updatedAt:string;verification?:unknown;idempotencyKey:string;retryCount:number;errorCode?:string};
const challenges=new Map<string,Challenge>();
const transactions=new Map<string,TxRecord>();
const idempotency=new Map<string,string>();
const inFlight=new Map<string,Promise<{record:TxRecord;unsigned:unknown;replayed:boolean}>>();
const sha=(v:string)=>createHash('sha256').update(v).digest();

export class BlockchainService {
  challenge(network:Network,address:string,sessionId:string){
    const adapter=adapters[network]; if(!adapter||!adapter.validateAddress(address))throw new Error('INVALID_NETWORK_OR_ADDRESS');
    const nonce=randomBytes(32).toString('base64url'),id=randomUUID(),timestamp=new Date().toISOString();
    const message=`LOTERIA AUTH\nWallet: ${address}\nNetwork: ${network}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
    challenges.set(id,{id,network,address,sessionId,nonceHash:sha(nonce),message,expiresAt:Date.now()+5*60_000});
    return {challengeId:id,message,expiresAt:new Date(Date.now()+5*60_000).toISOString()};
  }
  async verify(challengeId:string,sessionId:string,signature:string,publicKey?:string){
    const c=challenges.get(challengeId); if(!c||c.usedAt||c.expiresAt<Date.now()||c.sessionId!==sessionId)throw new Error('CHALLENGE_INVALID_EXPIRED_OR_USED');
    const nonce=/Nonce: ([^\n]+)/.exec(c.message)?.[1]||''; if(!nonce||!timingSafeEqual(c.nonceHash,sha(nonce)))throw new Error('CHALLENGE_TAMPERED');
    const valid=await adapters[c.network].verifyMessage(c.message,signature,c.address,publicKey); if(!valid)throw new Error('SIGNATURE_INVALID');
    c.usedAt=Date.now(); return {verified:true,network:c.network,address:c.address,verifiedAt:new Date().toISOString()};
  }
  balance(network:Network,address:string){return adapters[network].getBalance(address);}
  async create(network:Network,from:string,to:string,amount:string,key:string){
    const existing=idempotency.get(key);if(existing)return {record:transactions.get(existing)!,replayed:true};
    const pending=inFlight.get(key);if(pending){const result=await pending;return {...result,replayed:true};}
    const operation=(async()=>{if(!/^\d+$/.test(amount)||BigInt(amount)<=0n)throw new Error('INVALID_BASE_UNIT_AMOUNT');
      const built=await adapters[network].buildTransaction(from,to,amount),id=randomUUID(),now=new Date().toISOString();
      const record:TxRecord={id,network,from,to,amount,state:'SIGNATURE_PENDING',createdAt:now,updatedAt:now,idempotencyKey:key,retryCount:0};transactions.set(id,record);idempotency.set(key,id);
      return {record,unsigned:built.raw,replayed:false};})();
    inFlight.set(key,operation);try{return await operation;}finally{inFlight.delete(key);}
  }
  async submit(id:string,signed:unknown){const r=transactions.get(id);if(!r)throw new Error('TX_NOT_FOUND');if(r.hash)return r;if(r.state!=='SIGNATURE_PENDING')throw new Error('INVALID_STATE_TRANSITION');r.state='SIGNED';try{r.state='BROADCASTING';r.hash=await adapters[r.network].broadcastTransaction(signed);r.state='BROADCASTED';r.updatedAt=new Date().toISOString();return r;}catch(e){r.state='FAILED';r.retryCount++;r.errorCode=e instanceof Error?e.message:'BROADCAST_FAILED';r.updatedAt=new Date().toISOString();throw e;}}
  async status(id:string){const r=transactions.get(id);if(!r)throw new Error('TX_NOT_FOUND');if(r.hash&&['BROADCASTED','PENDING_CONFIRMATION','CONFIRMED'].includes(r.state)){const v=await adapters[r.network].getTransaction(r.hash);r.verification=v;r.state=v.confirmed?'CONFIRMED':v.found?'PENDING_CONFIRMATION':'BROADCASTED';r.updatedAt=new Date().toISOString();}return r;}
  async verifyRecord(id:string){const r=transactions.get(id);if(!r||!r.hash)throw new Error('TX_NOT_FOUND_OR_NOT_BROADCAST');const v=await adapters[r.network].getTransaction(r.hash);r.verification=v;if(!v.found)throw new Error('HASH_NOT_FOUND');if(!v.confirmed||v.success===false)throw new Error('TX_NOT_CONFIRMED');if(v.from!==r.from||v.to!==r.to||v.amount!==r.amount)throw new Error('TX_FIELDS_MISMATCH');r.state='VERIFIED';r.updatedAt=new Date().toISOString();return r;}
  async verifyTransaction(network:Network,hash:string){const a=adapters[network];if(!a)throw new Error('INVALID_NETWORK');return a.getTransaction(hash);}
  health(){return Promise.all(Object.values(adapters).map(a=>a.health()));}
  operations(){return [...transactions.values()];}
}
