export type Network = 'TRON_NILE' | 'SOLANA_DEVNET' | 'XRPL_TESTNET';
export type TxState = 'CREATED'|'CHALLENGE_PENDING'|'WALLET_VERIFIED'|'SIGNATURE_PENDING'|'SIGNED'|'BROADCASTING'|'BROADCASTED'|'PENDING_CONFIRMATION'|'CONFIRMED'|'VERIFIED'|'FAILED'|'EXPIRED';

export interface ChainTransaction {
  network: Network;
  from: string;
  to: string;
  amount: string;
  raw: unknown;
  hash?: string;
  state: TxState;
}

export interface VerificationResult {
  found: boolean;
  confirmed: boolean;
  blockOrLedger?: number;
  confirmations?: number;
  raw: unknown;
  from?: string;
  to?: string;
  amount?: string;
  success?: boolean;
}

export interface NetworkHealth { network:Network; rpc:string; healthy:boolean; height?:number; latencyMs:number; checkedAt:string; error?:string }

export interface BlockchainAdapter {
  readonly network: Network;
  validateAddress(address: string): boolean;
  getBalance(address: string): Promise<string>;
  verifyMessage(message: string, signature: string, address: string, publicKey?: string): Promise<boolean>;
  buildTransaction(from: string, to: string, amount: string): Promise<ChainTransaction>;
  broadcastTransaction(signed: unknown): Promise<string>;
  getTransaction(hash: string): Promise<VerificationResult>;
  health(): Promise<NetworkHealth>;
}
