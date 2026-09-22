import {afterEach,describe,expect,it,vi} from 'vitest';
import {Keypair} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {BlockchainService} from './service';
import {adapters} from './adapters';

afterEach(()=>vi.useRealTimers());
describe('wallet challenge',()=>{
  it('accepts one valid signature and rejects replay',async()=>{const svc=new BlockchainService(),kp=Keypair.generate(),address=kp.publicKey.toBase58();const c=svc.challenge('SOLANA_DEVNET',address,'session');const signature=bs58.encode(nacl.sign.detached(Buffer.from(c.message),kp.secretKey));await expect(svc.verify(c.challengeId,'session',signature)).resolves.toMatchObject({verified:true,address});await expect(svc.verify(c.challengeId,'session',signature)).rejects.toThrow('CHALLENGE_INVALID_EXPIRED_OR_USED');});
  it('rejects expired challenge',async()=>{vi.useFakeTimers();const svc=new BlockchainService(),kp=Keypair.generate();const c=svc.challenge('SOLANA_DEVNET',kp.publicKey.toBase58(),'session');vi.advanceTimersByTime(301_000);const signature=bs58.encode(nacl.sign.detached(Buffer.from(c.message),kp.secretKey));await expect(svc.verify(c.challengeId,'session',signature)).rejects.toThrow('CHALLENGE_INVALID_EXPIRED_OR_USED');});
  it('rejects a different signer',async()=>{const svc=new BlockchainService(),owner=Keypair.generate(),attacker=Keypair.generate();const c=svc.challenge('SOLANA_DEVNET',owner.publicKey.toBase58(),'session');const signature=bs58.encode(nacl.sign.detached(Buffer.from(c.message),attacker.secretKey));await expect(svc.verify(c.challengeId,'session',signature)).rejects.toThrow('SIGNATURE_INVALID');});
});
describe('idempotency',()=>{
  it('coalesces simultaneous duplicate creates',async()=>{const svc=new BlockchainService(),from=Keypair.generate().publicKey.toBase58(),to=Keypair.generate().publicKey.toBase58();vi.spyOn(adapters.SOLANA_DEVNET,'buildTransaction').mockResolvedValue({network:'SOLANA_DEVNET',from,to,amount:'1',raw:{unsigned:true},state:'SIGNATURE_PENDING'});const [a,b]=await Promise.all([svc.create('SOLANA_DEVNET',from,to,'1','same-key'),svc.create('SOLANA_DEVNET',from,to,'1','same-key')]);expect(a.record.id).toBe(b.record.id);expect([a.replayed,b.replayed].sort()).toEqual([false,true]);});
});
