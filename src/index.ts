#!/usr/bin/env node

import { Command } from 'commander';
import { Provider, Contract, Signer, utils, Abi, Transaction } from 'koilib';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as https from 'https';
import { lookup as dnsLookup } from 'dns/promises';
import * as readlineSync from 'readline-sync';
import { execSync } from 'child_process';
import { HDNode } from '@ethersproject/hdnode';
import tokenAbi from './abis/token.json';
import pobAbi from './abis/pob.json';
import packageJson from '../package.json';
import { FundClient, assertFundNetwork, formatFundVotes, parsePercentage, parsePositiveInteger, parseProjectId, PROJECT_STATUSES, terminalText, timestampIso } from './fund';
import { registerVortexCommands } from './vortex-cli';
import { registerMultisigCommands } from './multisig-cli';
import { DashboardProvider, dashboardError, parseDashboardInteger } from './dashboard-rpc';
import { DashboardProducerData, dashboardAge, dashboardValue, dashboardWholeUnits } from './dashboard-data';
import { parseTokenAmount, resolveTokenDecimals } from './token-amount';

const program = new Command();
const CLI_VERSION = packageJson.version;

const LATEST_CHANGES = [
  'Fund reads support an empty RPC ABI index through a pinned read-only Mainnet interface; voting still requires RPC metadata.',
  'Fund reads validate RPC envelopes and base64 while accepting protobuf-default empty votes without weakening allocation checks.',
  'Added contract-enforced multisig KOIN treasuries with offline approvals, policy rotation and verified bootstrap.',
  'Multisig waits through reversible inclusion until both reviewed RPCs establish irreversible finality.',
  'Multisig inclusion anchors and first-use journal durability are verified before terminal results or submission.',
  'producer-dashboard now bounds RPC sockets, staggers cached reads and preserves independent last-good balances.',
  'Added restricted Vortex mainnet profiles with authenticated review and two explicitly reviewed HTTPS RPCs.',
  'Vortex preflight supports advancing heads with protected-state receipt checks and independent finality corroboration.',
  'Added named encrypted wallets with hidden local secret input.',
  'Added Vortex V2 detached signing, separate payer, submission and reconciliation.',
  'Added fund-info, proposals, proposal, votes, and vote commands for Koinos Fund System projects.',
  'Fund voting supports password-free dry-runs, allocation checks, and post-inclusion verification.',
  'Added the expected mainnet chain ID to transaction network checks.',
  'Added --no-wait and --nonce to transfer commands for deterministic burst testing.',
  'Added --password-file and --yes for non-interactive wallet operations.',
  'Added transfer and token-transfer commands with dry-run support.',
  'Added official Koinos Foundation testnet support.',
  'producer-dashboard now paginates block fetches so --window can scan more than 1000 blocks.',
  'producer-dashboard now has a peers view with active peer IPs, geolocation, ping, and role heuristics.',
  'producer-dashboard now detects Fogata pools dynamically via get_pool_params and shows pool name.',
  'producer-dashboard now shows estimated APY and total virtual supply (VHP + KOIN).',
  'producer-dashboard now highlights Fogata pool addresses in orange.',
  'producer-dashboard now shows KOIN and VHP as whole numbers and removes SUM.',
  'producer-dashboard now shows KOIN, VHP, and SUM balances for active producers.',
  'Added producer-dashboard command for a live text-based view of active block producers.',
  'Added get-producer-key command to query the public key registered for a producer address.',
  'Added global --changes option to display the latest release notes.',
  'register-producer-key now supports one-argument mode using mainProducerAddress from config.',
  'Added config support for --main-producer-address with default producer address bootstrap.',
];

function showLatestChanges(): void {
  console.log(`\n📝 kcli v${CLI_VERSION} - Latest Changes`);
  console.log('─'.repeat(50));
  LATEST_CHANGES.forEach((change, index) => {
    console.log(` ${index + 1}. ${change}`);
  });
  console.log('─'.repeat(50));
}

// Default RPC endpoint (can be overridden with -r flag or config)
const DEFAULT_NETWORK = 'mainnet';
const DEFAULT_RPC = 'https://api.koinos.io';
const DEFAULT_MAIN_PRODUCER_ADDRESS = '14MHW6TF8gw8EuMRLCJc2PQHLzZLKuwGqb';
const ANSI_ORANGE = '\x1b[38;5;208m';
const ANSI_RESET = '\x1b[0m';

interface NetworkContracts {
  koin?: string;
  vhp?: string;
  pob?: string;
  fund?: string;
}

interface NetworkDefinition {
  name: string;
  label: string;
  rpc: string;
  chainId?: string;
  healthUrl?: string;
  faucetUrl?: string;
  contracts: NetworkContracts;
}

const NETWORKS: Record<string, NetworkDefinition> = {
  mainnet: {
    name: 'mainnet',
    label: 'Koinos Mainnet',
    rpc: DEFAULT_RPC,
    chainId: 'EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==',
    contracts: {
      koin: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
      vhp: '12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq',
      pob: '159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv',
      fund: '1A5BmMqV5jN5zBrdkhQumAfDZBzXLPBeN9',
    },
  },
  testnet: {
    name: 'testnet',
    label: 'Koinos Foundation Testnet',
    rpc: 'https://testnet.koinosfoundation.org/jsonrpc',
    chainId: 'EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==',
    healthUrl: 'https://testnet.koinosfoundation.org/health',
    faucetUrl: 'https://t.me/KoinosTestnetFaucetBot',
    contracts: {
      koin: '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju',
      vhp: '17n12ktwN79sR6ia9DDgCfmw77EgpbTyBi',
      pob: '1MAbK5pYkhp9yHnfhYamC3tfSLmVRTDjd9',
    },
  },
};

// Wallet and config file paths
const WALLET_DIR = path.join(os.homedir(), '.kcli');
const WALLET_FILE = path.join(WALLET_DIR, 'wallet.json');
const CONFIG_FILE = path.join(WALLET_DIR, 'config.json');

// Config interface
interface Config {
  defaultAccount?: string;
  network?: string;
  rpc?: string;
  mainProducerAddress?: string;
}

interface NetworkContext {
  networkName: string;
  definition: NetworkDefinition;
  rpc: string;
  contracts: NetworkContracts;
}

interface WalletUnlockOptions {
  passwordFile?: string;
}

interface ConfirmationOptions {
  yes?: boolean;
}

interface TransactionControlOptions {
  wait?: boolean;
  nonce?: string;
}

// Load config file
function loadConfig(): Config {
  const defaultConfig: Config = {
    network: DEFAULT_NETWORK,
    mainProducerAddress: DEFAULT_MAIN_PRODUCER_ADDRESS,
  };

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(data) as Config;
      const merged = { ...defaultConfig, ...parsed };

      // Backfill missing values into config file
      if (!parsed.mainProducerAddress || !parsed.network) {
        saveConfig(merged);
      }

      return merged;
    }
  } catch (error) {
    // Config file doesn't exist or is invalid, return empty config
  }

  // Create config file with defaults on first run
  saveConfig(defaultConfig);
  return defaultConfig;
}

// Save config file
function saveConfig(config: Config): void {
  ensureWalletDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function getSupportedNetworkNames(): string {
  return Object.keys(NETWORKS).join(', ');
}

function normalizeNetworkName(network: string | undefined): string {
  return (network || DEFAULT_NETWORK).trim().toLowerCase();
}

function resolveNetworkContext(): NetworkContext {
  const opts = program.opts<{ rpc?: string; network?: string }>();
  const config = loadConfig();
  const networkName = normalizeNetworkName(opts.network || config.network || DEFAULT_NETWORK);
  const definition = NETWORKS[networkName];

  if (!definition) {
    throw new Error(`Unsupported network "${networkName}". Supported networks: ${getSupportedNetworkNames()}`);
  }

  return {
    networkName,
    definition,
    rpc: opts.rpc || config.rpc || definition.rpc,
    contracts: definition.contracts,
  };
}

function getProvider(context: NetworkContext): Provider {
  return new Provider([context.rpc]);
}

function requireContract(context: NetworkContext, contractName: keyof NetworkContracts, commandName: string): string | null {
  const contractId = context.contracts[contractName];
  if (contractId) return contractId;

  console.log(`\n❌ ${commandName} needs the ${context.networkName} ${contractName.toUpperCase()} contract ID, which is not configured yet.`);
  console.log('   Use mainnet, provide a custom contract command where available, or add this contract to the network registry after verifying it.');
  return null;
}

function createProviderFromOptions(): { context: NetworkContext; provider: Provider } | null {
  try {
    const context = resolveNetworkContext();
    return { context, provider: getProvider(context) };
  } catch (error: any) {
    console.error(`\n❌ ${error.message || error}`);
    return null;
  }
}

function assertPreparedTransactionNetwork(context: NetworkContext, transaction: Transaction): boolean {
  if (!context.definition.chainId) return true;

  const actualChainId = transaction.transaction.header?.chain_id;
  if (actualChainId === context.definition.chainId) return true;

  console.log('\n❌ Prepared transaction chain ID does not match the selected network.');
  console.log(`   Network: ${context.networkName}`);
  console.log(`   Expected: ${context.definition.chainId}`);
  console.log(`   Actual:   ${actualChainId || '(missing)'}`);
  console.log('   Refusing to sign or submit this transaction.');
  return false;
}

function isValidAddress(address: string): boolean {
  try {
    return utils.isChecksumAddress(address);
  } catch (error) {
    return false;
  }
}

function getReceiptErrorDetails(error: any): string[] {
  const details: string[] = [];
  if (error.message) {
    details.push(`   Message: ${error.message}`);
  }
  if (error.code) {
    details.push(`   Code: ${error.code}`);
  }
  if (error.logs && error.logs.length > 0) {
    details.push(`   Logs: ${JSON.stringify(error.logs)}`);
  }
  if (error.receipt) {
    details.push(`   Receipt: ${JSON.stringify(error.receipt, null, 2)}`);
  }
  return details;
}

// Encryption settings
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const AUTH_TAG_LENGTH = 16;

// Derive encryption key from password
function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

// Encrypt data with password
function encrypt(data: string, password: string): { encrypted: string; salt: string; iv: string; authTag: string } {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  
  return {
    encrypted,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

// Decrypt data with password
function decrypt(encryptedData: { encrypted: string; salt: string; iv: string; authTag: string }, password: string): string {
  const salt = Buffer.from(encryptedData.salt, 'hex');
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const authTag = Buffer.from(encryptedData.authTag, 'hex');
  const key = deriveKey(password, salt);
  
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Prompt for password (hidden input)
function promptPassword(prompt: string = 'Enter password: '): string {
  return readlineSync.question(prompt, { hideEchoBack: true });
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function readPasswordFile(passwordFile: string): string {
  const resolvedPath = path.resolve(expandHome(passwordFile));
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Password file is not a regular file: ${resolvedPath}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Password file must not be readable by group or others: ${resolvedPath}`);
  }
  const password = fs.readFileSync(resolvedPath, 'utf8').replace(/\r?\n$/, '');
  if (!password) {
    throw new Error(`Password file is empty: ${resolvedPath}`);
  }
  return password;
}

function getWalletPassword(options: WalletUnlockOptions, prompt: string = 'Enter wallet password: '): string {
  if (options.passwordFile) {
    return readPasswordFile(options.passwordFile);
  }
  return promptPassword(prompt);
}

// Prompt for password with confirmation
function promptNewPassword(): string {
  const password = readlineSync.question('Enter new password: ', { hideEchoBack: true });
  const confirm = readlineSync.question('Confirm password: ', { hideEchoBack: true });
  
  if (password !== confirm) {
    throw new Error('Passwords do not match');
  }
  
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  
  return password;
}

// Wallet management functions
function ensureWalletDir(): void {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  }
}

interface EncryptedWallet {
  address: string;
  encryptedKey: {
    encrypted: string;
    salt: string;
    iv: string;
    authTag: string;
  };
  createdAt: string;
}

function saveWallet(privateKeyWif: string, address: string, password: string): void {
  ensureWalletDir();
  const encryptedKey = encrypt(privateKeyWif, password);
  const walletData: EncryptedWallet = {
    address,
    encryptedKey,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), { mode: 0o600 });
}

function loadWalletFile(): EncryptedWallet | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }
  const data = fs.readFileSync(WALLET_FILE, 'utf-8');
  return JSON.parse(data);
}

function loadWallet(password: string): { address: string; privateKey: string } | null {
  const walletFile = loadWalletFile();
  if (!walletFile) {
    return null;
  }
  
  try {
    const privateKey = decrypt(walletFile.encryptedKey, password);
    return {
      address: walletFile.address,
      privateKey,
    };
  } catch (error) {
    throw new Error('Invalid password');
  }
}

function deleteWallet(): boolean {
  if (fs.existsSync(WALLET_FILE)) {
    fs.unlinkSync(WALLET_FILE);
    return true;
  }
  return false;
}

// Function to fix ABI from chain (converts read-only to read_only, entry-point to entry_point)
function fixAbi(abi: Abi): Abi {
  if (!abi || !abi.methods) return abi;
  
  Object.keys(abi.methods).forEach((name) => {
    const method = abi.methods[name] as any;
    
    // Convert entry-point to entry_point
    if (method['entry-point'] && !method.entry_point) {
      method.entry_point = parseInt(method['entry-point'], 16);
      delete method['entry-point'];
    }
    
    // Convert read-only to read_only
    if (typeof method['read-only'] !== 'undefined' && typeof method.read_only === 'undefined') {
      method.read_only = method['read-only'];
      delete method['read-only'];
    }
  });
  
  return abi;
}

// Helper function to create a system token contract (KOIN, VHP) with bundled ABI
function getSystemTokenContract(provider: Provider, contractId: string): Contract {
  return new Contract({
    id: contractId,
    abi: tokenAbi,
    provider,
  });
}

// Helper function to create a token contract with ABI fetched from chain
async function getTokenContract(provider: Provider, contractId: string): Promise<Contract> {
  const contract = new Contract({
    id: contractId,
    provider,
  });
  
  // Fetch ABI from chain
  await contract.fetchAbi({ updateFunctions: false, updateSerializer: true });
  
  // Fix the ABI format
  if (contract.abi) {
    contract.abi = fixAbi(contract.abi);
    contract.updateFunctionsFromAbi();
  }
  
  return contract;
}

program
  .name('kcli')
  .description('A Koinos blockchain command line tool')
  .version(CLI_VERSION)
  .option('-n, --network <network>', `Network (${getSupportedNetworkNames()})`)
  .option('-r, --rpc <url>', 'RPC endpoint URL override')
  .option('-c, --changes', 'Show latest changes and exit');

program.hook('preAction', () => {
  const opts = program.opts<{ changes?: boolean }>();
  if (opts.changes) {
    showLatestChanges();
    process.exit(0);
  }
});

program.action(() => {
  const opts = program.opts<{ changes?: boolean }>();
  if (opts.changes) {
    showLatestChanges();
    return;
  }
  program.help({ error: true });
});

// Get chain info
program
  .command('chain-info')
  .description('Get blockchain information')
  .action(async () => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    
    try {
      const headInfo = await provider.getHeadInfo();
      console.log('\n📊 Chain Info:');
      console.log(`  Network: ${context.networkName}`);
      console.log(`  RPC: ${context.rpc}`);
      console.log(`  Head Block: ${headInfo.head_topology?.height}`);
      console.log(`  Block ID: ${headInfo.head_topology?.id}`);
      console.log(`  Last Irreversible Block: ${headInfo.last_irreversible_block}`);
    } catch (error) {
      console.error('Error fetching chain info:', error);
    }
  });

// Get block content
program
  .command('block')
  .description('Get block content by height or ID')
  .argument('<heightOrId>', 'Block height (number) or block ID (base64/hex)')
  .option('--full', 'Show full transaction details')
  .action(async (heightOrId: string, options: { full?: boolean }) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { provider } = resolved;
    
    try {
      let blockId: string | undefined;
      let blockHeight: number | undefined;
      
      // Check if it's a number (height) or string (ID)
      if (/^\d+$/.test(heightOrId)) {
        blockHeight = parseInt(heightOrId, 10);
        // Get block ID from height using getBlocksById with height
        const headInfo = await provider.getHeadInfo();
        const blocks = await provider.call<{block_items: any[]}>('block_store.get_blocks_by_height', {
          head_block_id: headInfo.head_topology?.id,
          ancestor_start_height: blockHeight,
          num_blocks: 1,
          return_block: true,
          return_receipt: true,
        });
        
        if (!blocks.block_items || blocks.block_items.length === 0) {
          console.error(`\n❌ Block at height ${blockHeight} not found.`);
          return;
        }
        
        const blockItem = blocks.block_items[0];
        const block = blockItem.block;
        const receipt = blockItem.receipt;
        
        console.log('\n📦 Block Information:');
        console.log('─'.repeat(60));
        console.log(`  Height:        ${blockItem.block_height}`);
        console.log(`  Block ID:      ${blockItem.block_id}`);
        console.log(`  Previous:      ${block?.header?.previous}`);
        console.log(`  Timestamp:     ${new Date(parseInt(block?.header?.timestamp || '0')).toISOString()}`);
        console.log(`  Signer:        ${block?.header?.signer}`);
        
        const txCount = block?.transactions?.length || 0;
        console.log(`  Transactions:  ${txCount}`);
        
        if (receipt) {
          console.log(`  Disk Used:     ${receipt.disk_storage_used || 0} bytes`);
          console.log(`  Net Used:      ${receipt.network_bandwidth_used || 0} bytes`);
          console.log(`  Compute Used:  ${receipt.compute_bandwidth_used || 0}`);
        }
        
        if (txCount > 0 && block.transactions) {
          console.log('\n📝 Transactions:');
          console.log('─'.repeat(60));
          
          for (let i = 0; i < block.transactions.length; i++) {
            const tx = block.transactions[i];
            const txId = tx.id || 'unknown';
            const payer = tx.header?.payer || 'unknown';
            const opCount = tx.operations?.length || 0;
            
            console.log(`\n  [${i + 1}] Transaction ID: ${txId}`);
            console.log(`      Payer: ${payer}`);
            console.log(`      Operations: ${opCount}`);
            
            if (options.full && tx.operations) {
              for (let j = 0; j < tx.operations.length; j++) {
                const op = tx.operations[j];
                if (op.call_contract) {
                  console.log(`      - Op ${j + 1}: Call Contract`);
                  console.log(`        Contract: ${op.call_contract.contract_id}`);
                  console.log(`        Entry Point: 0x${op.call_contract.entry_point?.toString(16)}`);
                } else if (op.upload_contract) {
                  console.log(`      - Op ${j + 1}: Upload Contract`);
                }
              }
            }
          }
        }
        
      } else {
        // It's a block ID
        blockId = heightOrId;
        const blocks = await provider.call<{block_items: any[]}>('block_store.get_blocks_by_id', {
          block_ids: [blockId],
          return_block: true,
          return_receipt: true,
        });
        
        if (!blocks.block_items || blocks.block_items.length === 0) {
          console.error(`\n❌ Block with ID ${blockId} not found.`);
          return;
        }
        
        const blockItem = blocks.block_items[0];
        const block = blockItem.block;
        const receipt = blockItem.receipt;
        
        console.log('\n📦 Block Information:');
        console.log('─'.repeat(60));
        console.log(`  Height:        ${blockItem.block_height}`);
        console.log(`  Block ID:      ${blockItem.block_id}`);
        console.log(`  Previous:      ${block?.header?.previous}`);
        console.log(`  Timestamp:     ${new Date(parseInt(block?.header?.timestamp || '0')).toISOString()}`);
        console.log(`  Signer:        ${block?.header?.signer}`);
        
        const txCount = block?.transactions?.length || 0;
        console.log(`  Transactions:  ${txCount}`);
        
        if (receipt) {
          console.log(`  Disk Used:     ${receipt.disk_storage_used || 0} bytes`);
          console.log(`  Net Used:      ${receipt.network_bandwidth_used || 0} bytes`);
          console.log(`  Compute Used:  ${receipt.compute_bandwidth_used || 0}`);
        }
        
        if (txCount > 0 && block.transactions) {
          console.log('\n📝 Transactions:');
          console.log('─'.repeat(60));
          
          for (let i = 0; i < block.transactions.length; i++) {
            const tx = block.transactions[i];
            const txId = tx.id || 'unknown';
            const payer = tx.header?.payer || 'unknown';
            const opCount = tx.operations?.length || 0;
            
            console.log(`\n  [${i + 1}] Transaction ID: ${txId}`);
            console.log(`      Payer: ${payer}`);
            console.log(`      Operations: ${opCount}`);
            
            if (options.full && tx.operations) {
              for (let j = 0; j < tx.operations.length; j++) {
                const op = tx.operations[j];
                if (op.call_contract) {
                  console.log(`      - Op ${j + 1}: Call Contract`);
                  console.log(`        Contract: ${op.call_contract.contract_id}`);
                  console.log(`        Entry Point: 0x${op.call_contract.entry_point?.toString(16)}`);
                } else if (op.upload_contract) {
                  console.log(`      - Op ${j + 1}: Upload Contract`);
                }
              }
            }
          }
        }
      }
      
    } catch (error: any) {
      console.error('\n❌ Error fetching block:', error.message || error);
    }
  });

// Get account balance (KOIN and VHP)
program
  .command('balance')
  .description('Get KOIN, VHP and Mana balance for an address (uses default account from config if not specified)')
  .argument('[address]', 'Koinos address (optional if default account is configured)')
  .action(async (addressArg?: string) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    
    // Use provided address or fall back to config default
    const config = loadConfig();
    const address = addressArg || config.defaultAccount;
    
    if (!address) {
      console.error('\n❌ No address provided and no default account configured.');
      console.error('   Usage: kcli balance <address>');
      console.error('   Or set a default account: kcli config --default-account <address>');
      return;
    }
    
    try {
      const koinContract = requireContract(context, 'koin', 'balance');
      if (!koinContract) return;

      const koin = getSystemTokenContract(provider, koinContract);
      
      const { result: koinResult } = await koin.functions.balance_of({ owner: address });
      const koinBalance = koinResult?.value ? utils.formatUnits(koinResult.value, 8) : '0';

      let vhpBalance = '(not configured for this network)';
      if (context.contracts.vhp) {
        const vhp = getSystemTokenContract(provider, context.contracts.vhp);
        const { result: vhpResult } = await vhp.functions.balance_of({ owner: address });
        vhpBalance = vhpResult?.value ? utils.formatUnits(vhpResult.value, 8) : '0';
      }
      
      // Get mana (resource credits)
      const rc = await provider.getAccountRc(address);
      const mana = rc ? utils.formatUnits(rc, 8) : '0';
      
      console.log(`\n💰 Balances for ${address}:`);
      console.log(`   Network: ${context.networkName}`);
      console.log(`   KOIN: ${koinBalance}`);
      console.log(`   VHP:  ${vhpBalance}`);
      console.log(`   Mana: ${mana}`);
    } catch (error: any) {
      if (error.message?.includes('system space')) {
        console.log('\n⚠️  Cannot read balance from this RPC endpoint (system contract restriction).');
        console.log('   Try using a local node or an RPC endpoint with full access.');
        console.log('   Use the "rc" command to check available mana instead.');
      } else {
        console.error('Error fetching balance:', error.message || error);
      }
    }
  });

// Get VHP balance
program
  .command('vhp')
  .description('Get VHP (Virtual Hash Power) balance for an address')
  .argument('<address>', 'Koinos address')
  .action(async (address: string) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    
    try {
      const vhpContract = requireContract(context, 'vhp', 'vhp');
      if (!vhpContract) return;
      const vhp = getSystemTokenContract(provider, vhpContract);

      const { result } = await vhp.functions.balance_of({ owner: address });
      const balance = result?.value ? utils.formatUnits(result.value, 8) : '0';
      
      console.log(`\n⚡ VHP Balance for ${address}:`);
      console.log(`   ${balance} VHP`);
    } catch (error: any) {
      if (error.message?.includes('system space')) {
        console.log('\n⚠️  Cannot read VHP balance from this RPC endpoint (system contract restriction).');
      } else {
        console.error('Error fetching VHP balance:', error.message || error);
      }
    }
  });

// Get token balance (any KCS-4 token)
program
  .command('token-balance')
  .description('Get balance for any KCS-4 token')
  .argument('<contractId>', 'Token contract address')
  .argument('<address>', 'Koinos address')
  .action(async (contractId: string, address: string) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { provider } = resolved;
    
    try {
      const token = await getTokenContract(provider, contractId);

      // Get token info
      const [nameResult, symbolResult, decimalsResult, balanceResult] = await Promise.all([
        token.functions.name ? token.functions.name({}) : { result: { value: 'Unknown' } },
        token.functions.symbol ? token.functions.symbol({}) : { result: { value: '???' } },
        token.functions.decimals ? token.functions.decimals({}) : { result: { value: 8 } },
        token.functions.balance_of({ owner: address }),
      ]);

      const name = nameResult.result?.value || 'Unknown';
      const symbol = symbolResult.result?.value || '???';
      const decimals = decimalsResult.result?.value || 8;
      const balance = balanceResult.result?.value 
        ? utils.formatUnits(balanceResult.result.value, decimals) 
        : '0';
      
      console.log(`\n🪙 ${name} (${symbol}) Balance for ${address}:`);
      console.log(`   ${balance} ${symbol}`);
    } catch (error) {
      console.error('Error fetching token balance:', error);
    }
  });

async function executeTokenTransfer(
  context: NetworkContext,
  provider: Provider,
  contractId: string,
  to: string,
  amount: string,
  options: { dryRun?: boolean } & WalletUnlockOptions & ConfirmationOptions & TransactionControlOptions,
): Promise<void> {
  if (!isValidAddress(to)) {
    console.log('\n❌ Invalid recipient address format.');
    return;
  }

  const walletFile = loadWalletFile();
  if (!walletFile) {
    console.log('\n❌ No wallet found. Import one first with: kcli import-wallet <privateKey>');
    return;
  }

  console.log(`\n🔐 Unlocking wallet for address: ${walletFile.address}`);
  let password: string;
  try {
    password = getWalletPassword(options);
  } catch (error: any) {
    console.error(`❌ ${error.message}`);
    return;
  }

  let wallet;
  try {
    wallet = loadWallet(password);
    if (!wallet) {
      console.error('❌ Failed to load wallet.');
      return;
    }
  } catch (error: any) {
    console.error('❌ Invalid password. Please try again.');
    return;
  }

  try {
    const signer = Signer.fromWif(wallet.privateKey);
    signer.provider = provider;

    const token = new Contract({
      id: contractId,
      abi: tokenAbi,
      provider,
      signer,
    });

    const readOptional = async <T>(promise: Promise<T>): Promise<T | undefined> => {
      try {
        return await promise;
      } catch {
        return undefined;
      }
    };

    const [nameResult, symbolResult, decimalsResult, balanceResult] = await Promise.all([
      readOptional(token.functions.name({})),
      readOptional(token.functions.symbol({})),
      readOptional(token.functions.decimals({})),
      token.functions.balance_of({ owner: wallet.address }),
    ]);

    const isConfiguredKoin = contractId === context.contracts.koin;
    const isConfiguredVhp = contractId === context.contracts.vhp;
    const tokenName = nameResult?.result?.value || (isConfiguredKoin ? 'KOIN' : isConfiguredVhp ? 'VHP' : 'Token');
    const tokenSymbol = symbolResult?.result?.value || (isConfiguredKoin ? 'KOIN' : isConfiguredVhp ? 'VHP' : 'TOKEN');
    // KOIN and VHP always have 8 decimals; never let the RPC change how an
    // amount is encoded. Custom tokens use the reported value after a sanity check.
    // A successful read with an empty result is the protobuf default (0 decimals);
    // only a failed read counts as unreadable.
    const reportedDecimals = decimalsResult === undefined ? undefined : (decimalsResult.result?.value ?? 0);
    let decimals: number;
    let transferAmount: bigint;
    try {
      decimals = resolveTokenDecimals(reportedDecimals, { systemToken: isConfiguredKoin || isConfiguredVhp });
      transferAmount = parseTokenAmount(amount, decimals);
    } catch (error: any) {
      console.log(`\n❌ ${error.message}`);
      return;
    }
    const currentBalance = balanceResult.result?.value ? BigInt(balanceResult.result.value) : BigInt(0);
    const currentFormatted = utils.formatUnits(currentBalance.toString(), decimals);
    const transferFormatted = utils.formatUnits(transferAmount.toString(), decimals);

    if (transferAmount > currentBalance) {
      console.log('\n❌ Insufficient token balance.');
      console.log(`   Requested: ${transferFormatted} ${tokenSymbol}`);
      console.log(`   Available: ${currentFormatted} ${tokenSymbol}`);
      return;
    }

    const availableMana = await provider.getAccountRc(wallet.address);
    const manaValue = availableMana ? BigInt(availableMana) : BigInt(0);
    const manaFormatted = utils.formatUnits(manaValue.toString(), 8);
    const estimatedManaNeeded = BigInt(20000000); // ~0.2 mana should be enough for a simple token transfer

    if (manaValue < estimatedManaNeeded) {
      console.log('\n❌ Insufficient mana to execute transaction.');
      console.log(`   Available Mana: ${manaFormatted}`);
      console.log('   Estimated Needed: ~0.2');
      console.log('\n   💡 Mana regenerates over time based on your KOIN balance.');
      return;
    }

    const { operation: transferOp } = await token.functions.transfer({
      from: wallet.address,
      to,
      value: transferAmount.toString(),
    }, { onlyOperation: true });

    const rcLimit = (manaValue * BigInt(10)) / BigInt(100);
    const transaction = new Transaction({
      signer,
      provider,
      options: {
        rcLimit: rcLimit.toString(),
      },
    });

    await transaction.pushOperation(transferOp);
    await transaction.prepare({
      ...(options.nonce && { nonce: options.nonce }),
    });
    if (!assertPreparedTransactionNetwork(context, transaction)) return;

    console.log('\n💸 Transfer Summary:');
    console.log(`   Network: ${context.networkName}`);
    console.log(`   Token: ${tokenName} (${tokenSymbol})`);
    console.log(`   Contract: ${contractId}`);
    console.log(`   From: ${wallet.address}`);
    console.log(`   To: ${to}`);
    console.log(`   Amount: ${transferFormatted} ${tokenSymbol} (${transferAmount.toString()} base units, ${decimals} decimals)`);
    console.log(`   Current Balance: ${currentFormatted} ${tokenSymbol}`);
    console.log(`   Available Mana: ${manaFormatted}`);

    console.log('\n📝 Transaction Details (BEFORE SIGNING):');
    console.log('─'.repeat(50));
    console.log(`   Transaction ID: ${transaction.transaction.id}`);
    console.log(`   Payer: ${transaction.transaction.header?.payer}`);
    console.log(`   Nonce: ${transaction.transaction.header?.nonce}`);
    console.log(`   RC Limit: ${transaction.transaction.header?.rc_limit}`);
    console.log(`   Chain ID: ${transaction.transaction.header?.chain_id}`);
    console.log(`   Contract: ${transferOp.call_contract?.contract_id}`);
    console.log(`   Entry Point: ${transferOp.call_contract?.entry_point}`);
    console.log(`   Args (base64): ${transferOp.call_contract?.args}`);
    console.log('─'.repeat(50));

    if (options.dryRun) {
      console.log('\n📋 Dry run - transaction NOT signed or submitted.');
      return;
    }

    if (!options.yes) {
      const confirm = readlineSync.question('\n⚠️  Type "TRANSFER" to confirm and sign: ');
      if (confirm !== 'TRANSFER') {
        console.log('\n❌ Transaction cancelled.');
        return;
      }
    }

    console.log('\n   Signing and submitting transaction...\n');
    await transaction.sign();
    const receipt = await transaction.send();

    console.log('✅ Transfer transaction submitted!');
    console.log(`   Transaction ID: ${transaction.transaction.id}`);

    if (receipt) {
      if (receipt.logs && receipt.logs.length > 0) {
        console.log('   Logs:', receipt.logs);
      }
      if (receipt.events && receipt.events.length > 0) {
        console.log(`   Events: ${receipt.events.length} event(s)`);
      }
    }

    if (options.wait !== false) {
      console.log('\n⏳ Waiting for transaction to be included in a block...');
      try {
        const blockInfo = await transaction.wait('byTransactionId', 60000);
        console.log(`   ✅ Transaction confirmed in block ${blockInfo?.blockNumber || 'unknown'}`);
      } catch (waitError: any) {
        console.log('   ⚠️  Could not confirm transaction (timeout). Balances may not be updated yet.');
      }
    } else {
      console.log('\n⏭️  Skipped confirmation wait (--no-wait).');
      console.log('   Use block/transaction regression checks to verify inclusion.');
      return;
    }

    const { result: newSenderBalanceResult } = await token.functions.balance_of({ owner: wallet.address });
    const { result: newRecipientBalanceResult } = await token.functions.balance_of({ owner: to });
    const newSenderBalance = newSenderBalanceResult?.value ? utils.formatUnits(newSenderBalanceResult.value, decimals) : '0';
    const newRecipientBalance = newRecipientBalanceResult?.value ? utils.formatUnits(newRecipientBalanceResult.value, decimals) : '0';

    console.log('\n📊 Updated Balances:');
    console.log(`   Sender:    ${newSenderBalance} ${tokenSymbol}`);
    console.log(`   Recipient: ${newRecipientBalance} ${tokenSymbol}`);
  } catch (error: any) {
    console.error('\n❌ Error transferring tokens:');
    const details = getReceiptErrorDetails(error);
    if (details.length) {
      details.forEach((detail) => console.error(detail));
    } else {
      console.error(`   ${error}`);
    }
  }
}

// Transfer KOIN
program
  .command('transfer')
  .description('Transfer KOIN to another address')
  .argument('<to>', 'Recipient Koinos address')
  .argument('<amount>', 'Amount of KOIN to transfer')
  .option('--dry-run', 'Show transaction details without signing or submitting')
  .option('--password-file <path>', 'Read wallet password from a local 0600 file')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--no-wait', 'Do not wait for block inclusion after submission')
  .option('--nonce <base64url>', 'Use an explicit base64url-encoded transaction nonce')
  .action(async (to: string, amount: string, options: { dryRun?: boolean } & WalletUnlockOptions & ConfirmationOptions & TransactionControlOptions) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    const koinContract = requireContract(context, 'koin', 'transfer');
    if (!koinContract) return;

    await executeTokenTransfer(context, provider, koinContract, to, amount, options);
  });

// Transfer any KCS-4 token
program
  .command('token-transfer')
  .description('Transfer any KCS-4 token to another address (KOIN/VHP use 8 decimals; other tokens need readable decimals from 0 to 18)')
  .argument('<contractId>', 'Token contract address')
  .argument('<to>', 'Recipient Koinos address')
  .argument('<amount>', 'Token amount to transfer')
  .option('--dry-run', 'Show transaction details without signing or submitting')
  .option('--password-file <path>', 'Read wallet password from a local 0600 file')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--no-wait', 'Do not wait for block inclusion after submission')
  .option('--nonce <base64url>', 'Use an explicit base64url-encoded transaction nonce')
  .action(async (contractId: string, to: string, amount: string, options: { dryRun?: boolean } & WalletUnlockOptions & ConfirmationOptions & TransactionControlOptions) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;

    if (!isValidAddress(contractId)) {
      console.log('\n❌ Invalid token contract address format.');
      return;
    }

    await executeTokenTransfer(context, provider, contractId, to, amount, options);
  });

interface FundOptions {
  fundContract?: string;
  json?: boolean;
}

function fundError(error: unknown): void {
  console.error(`Error: ${terminalText(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}

async function connectFund(options: FundOptions, readOnly = true) {
  const context = resolveNetworkContext();
  const provider = getProvider(context);
  const fund = await FundClient.connect(context, provider, options.fundContract, readOnly);
  if (fund.abiSource === 'bundled-read-only') console.error('Note: RPC ABI index is empty for KFS; using the bundled read-only Mainnet interface. Voting still requires compatible RPC ABI metadata.');
  return { context, provider, fund };
}

function fundOutput(options: FundOptions, data: Record<string, unknown>, render: () => void): void {
  if (options.json) console.log(JSON.stringify(data, null, 2));
  else render();
}

function fundCommand(name: string, description: string): Command {
  return program.command(name).description(description)
    .option('--fund-contract <address>', 'Override the fund contract for a verified deployment');
}

fundCommand('fund-info', 'Read Koinos Fund System settings')
  .option('--json', 'Print JSON')
  .action(async (options: FundOptions) => {
    try {
      const { context, fund } = await connectFund(options);
      const globals = await fund.globals();
      const balances = await fund.balances(fund.contract.getId());
      fundOutput(options, { network: context.networkName, rpc: context.rpc, contract: fund.contract.getId(), abi_source: fund.abiSource, ...globals, balances }, () => {
        console.log(`Koinos Fund System (${context.networkName})`);
        console.log(`Contract: ${fund.contract.getId()}`);
        console.log(`Projects: ${globals.total_projects} total, ${globals.total_active_projects} active, ${globals.total_upcoming_projects} upcoming`);
        console.log(`Fund balance: ${utils.formatUnits(balances.koin, 8)} KOIN`);
        console.log(`Remaining balance (contract accounting): ${utils.formatUnits(globals.remaining_balance, 8)} KOIN`);
        console.log(`Payment times: ${globals.payment_times.map(timestampIso).join(', ') || '(none)'}`);
      });
    } catch (error) { fundError(error); }
  });

fundCommand('proposals', 'List Koinos Fund System projects')
  .option('--status <status>', 'Project status: active, upcoming, or past', 'active')
  .option('--order <order>', 'Order by votes or date (past projects use date)')
  .option('--ascending', 'Sort in ascending order')
  .option('--limit <count>', 'Page size (1-100)', '20')
  .option('--cursor <cursor>', 'Continue from a returned pagination cursor')
  .option('--all', 'Read all pages for the selected status')
  .option('--json', 'Print JSON with raw contract values')
  .action(async (options: FundOptions & { status: string; order?: string; ascending?: boolean; limit: string; cursor?: string; all?: boolean }) => {
    try {
      const limit = parsePositiveInteger(options.limit, 'Page limit', 100);
      const { context, fund } = await connectFund(options);
      const page = await fund.projects({ ...options, limit, order: options.order || (options.status === 'past' ? 'date' : 'votes'), descending: !options.ascending });
      fundOutput(options, { network: context.networkName, contract: fund.contract.getId(), abi_source: fund.abiSource, ...page }, () => {
        console.log(`KFS ${options.status} projects (${context.networkName})`);
        for (const project of page.projects) {
          console.log(`${project.id}  ${terminalText(project.title)}  | ${formatFundVotes(project.total_votes)} votes | ${utils.formatUnits(project.monthly_payment, 8)} KOIN/month`);
        }
        if (!page.projects.length) console.log('No projects found.');
        if (page.nextCursor) console.log(`Next cursor: ${page.nextCursor}`);
      });
    } catch (error) { fundError(error); }
  });

fundCommand('proposal <id>', 'Read a Koinos Fund System project')
  .option('--json', 'Print JSON with raw contract values')
  .action(async (idArg: string, options: FundOptions) => {
    try {
      const id = parseProjectId(idArg);
      const { context, fund } = await connectFund(options);
      const project = await fund.project(id);
      fundOutput(options, { network: context.networkName, contract: fund.contract.getId(), abi_source: fund.abiSource, project }, () => {
        console.log(`Project ${id}: ${terminalText(project.title)}`);
        console.log(`Status: ${Object.keys(PROJECT_STATUSES).find(key => PROJECT_STATUSES[key] === project.status) || 'unknown'}`);
        console.log(`Creator: ${project.creator}`);
        console.log(`Beneficiary: ${project.beneficiary}`);
        console.log(`Monthly payment: ${utils.formatUnits(project.monthly_payment, 8)} KOIN`);
        console.log(`Dates: ${timestampIso(project.start_date)} to ${timestampIso(project.end_date)}`);
        console.log(`Votes: ${formatFundVotes(project.total_votes)}`);
        console.log(terminalText(project.description));
      });
    } catch (error) { fundError(error); }
  });

fundCommand('votes [address]', 'Read an account\'s Koinos Fund System allocations')
  .option('--json', 'Print JSON with raw contract timestamps')
  .action(async (addressArg: string | undefined, options: FundOptions) => {
    try {
      const address = addressArg || loadWalletFile()?.address || loadConfig().defaultAccount;
      if (!address || !isValidAddress(address)) throw new Error('Provide a valid voter address or import/configure an account.');
      const { context, fund } = await connectFund(options);
      const votes = await fund.votes(address);
      const allocated = votes.reduce((sum, vote) => sum + vote.weight * 5, 0);
      fundOutput(options, { network: context.networkName, contract: fund.contract.getId(), abi_source: fund.abiSource, voter: address, allocated_percent: allocated, votes }, () => {
        console.log(`KFS votes for ${address} (${context.networkName})`);
        for (const vote of votes) {
          console.log(`Project ${vote.project_id}: ${vote.weight * 5}% | expires ${timestampIso(vote.expiration)}${BigInt(vote.expiration) <= BigInt(Date.now()) ? ' (expired)' : ''}`);
        }
        console.log(`Recorded allocation: ${allocated}% (includes expired records until removed/updated).`);
      });
    } catch (error) { fundError(error); }
  });

fundCommand('vote <id>', 'Update, renew, or remove a Koinos Fund System vote')
  .requiredOption('--percent <percent>', 'Allocation from 0 to 100 in steps of 5; 0 removes a vote')
  .option('--address <address>', 'Public voter address for dry-run only')
  .option('--dry-run', 'Prepare without unlocking, signing, or submitting')
  .option('--rc-limit <units>', 'RC limit in base units (default: 10% of available mana)')
  .option('--password-file <path>', 'Read wallet password from a local 0600 file')
  .option('-y, --yes', 'Skip the VOTE confirmation prompt')
  .option('--no-wait', 'Return after submission without inclusion/readback verification')
  .option('--wait-timeout <seconds>', 'Inclusion timeout (1-300 seconds)', '60')
  .action(async (idArg: string, options: FundOptions & WalletUnlockOptions & ConfirmationOptions & {
    percent: string; address?: string; dryRun?: boolean; rcLimit?: string; wait?: boolean; waitTimeout: string;
  }) => {
    try {
      const id = parseProjectId(idArg);
      const percent = parsePercentage(options.percent);
      const timeout = parsePositiveInteger(options.waitTimeout, 'Wait timeout', 300) * 1000;
      if (options.address && !options.dryRun) throw new Error('--address is only available with --dry-run. Signed votes use the imported wallet.');
      const address = options.address || loadWalletFile()?.address || (options.dryRun ? loadConfig().defaultAccount : undefined);
      if (!address || !isValidAddress(address)) throw new Error('Import a wallet or supply --address for a dry-run.');
      const { context, provider, fund } = await connectFund(options, false);
      const prepared = await fund.prepareVote(id, percent, address, options.rcLimit);
      const { transaction, allocation } = prepared;
      const txId = transaction.transaction.id!;
      console.log('KFS Vote Summary (unsigned)');
      console.log(`Network: ${context.networkName}`);
      console.log(`RPC: ${context.rpc}`);
      console.log(`Fund contract: ${fund.contract.getId()}`);
      console.log(`Voter: ${address}`);
      console.log(`Project ${id}: ${terminalText(prepared.project.title)}`);
      console.log(`Allocation: ${(allocation.previous?.weight || 0) * 5}% -> ${percent}%`);
      console.log(`Total recorded allocation: ${allocation.usedWeight * 5}% -> ${allocation.totalWeight * 5}%`);
      console.log(`Balances: ${utils.formatUnits(prepared.balances.koin, 8)} KOIN, ${utils.formatUnits(prepared.balances.vhp, 8)} VHP`);
      console.log(`Available mana: ${utils.formatUnits(prepared.availableMana, 8)}`);
      if (percent > 0 && prepared.expiration) console.log(`Expected expiration: ${timestampIso(prepared.expiration)}`);
      console.log(JSON.stringify(transaction.transaction, null, 2));
      if (options.dryRun) {
        console.log('Dry run: wallet not unlocked; transaction not signed or submitted. Contract execution is not simulated.');
        return;
      }
      if (!options.yes && readlineSync.question('Type "VOTE" to confirm: ') !== 'VOTE') {
        console.log('Vote cancelled.');
        return;
      }
      await assertFundNetwork(context, provider);
      const wallet = loadWallet(getWalletPassword(options));
      if (!wallet || wallet.address !== address) throw new Error('Imported wallet changed during vote preparation.');
      const signer = Signer.fromWif(wallet.privateKey);
      if (signer.getAddress() !== address) throw new Error('Wallet key does not match its recorded voter address.');
      signer.provider = provider;
      transaction.signer = signer;
      await transaction.sign();
      const receipt = await transaction.send();
      if (receipt.rpc_error) throw new Error(`Submission outcome is unknown for ${txId}. Check inclusion before retrying.`);
      if (receipt.id !== txId || receipt.reverted) throw new Error(`Vote transaction ${txId} was rejected or reverted. ${receipt.logs?.map(terminalText).join(' ') || ''}`);
      console.log(`Vote submitted: ${txId}`);
      if (options.wait === false) {
        console.log('Inclusion and allocation readback have not been verified (--no-wait).');
        return;
      }
      let inclusion;
      try { inclusion = await transaction.wait('byTransactionId', timeout); }
      catch {
        console.error(`Inclusion is unconfirmed for ${txId}. Check the transaction before retrying; it may still be included.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Included in block ${inclusion.blockNumber || inclusion.blockId} (not irreversible finality).`);
      const blocks = await provider.getBlocksById([inclusion.blockId], { returnBlock: false, returnReceipt: true });
      const includedReceipt = blocks.block_items?.find(block => block.block_id === inclusion.blockId)?.receipt?.transaction_receipts?.find(item => item.id === txId);
      if (!includedReceipt) throw new Error(`Included transaction ${txId} has no available block receipt; execution is unverified.`);
      if (includedReceipt.reverted) throw new Error(`Included vote ${txId} reverted. ${includedReceipt.logs?.map(terminalText).join(' ') || ''}`);
      const current = (await fund.votes(address)).find(vote => vote.project_id === id);
      if (percent === 0 ? !!current : current?.weight !== allocation.newWeight) {
        throw new Error(`Allocation readback does not match transaction ${txId}. Inspect current votes before retrying.`);
      }
      console.log(`Allocation readback verified: ${percent}%${current ? `, expires ${timestampIso(current.expiration)}` : ' (removed)'}.`);
    } catch (error) { fundError(error); }
  });

// Generate new wallet
program
  .command('generate-wallet')
  .description('Generate a new Koinos wallet')
  .action(() => {
    // Generate random 32 bytes and use as seed
    const randomBytes = crypto.randomBytes(32).toString('hex');
    const signer = Signer.fromSeed(randomBytes);
    
    console.log('\n🔑 New Wallet Generated:');
    console.log(`  Address: ${signer.getAddress()}`);
    console.log(`  Private Key (WIF): ${signer.getPrivateKey('wif')}`);
    console.log('\n⚠️  IMPORTANT: Save your private key securely!');
  });

// Derive accounts from seed phrase (BIP-39/BIP-44) - Kondor compatible
program
  .command('derive-from-seed')
  .description('Derive the first N accounts from a BIP-39 seed phrase (Kondor compatible)')
  .argument('<seedPhrase>', 'BIP-39 mnemonic seed phrase (12 or 24 words)')
  .option('-n, --num-accounts <number>', 'Number of accounts to derive', '2')
  .action((seedPhrase: string, options: { numAccounts: string }) => {
    try {
      const numAccounts = parseInt(options.numAccounts, 10);
      if (isNaN(numAccounts) || numAccounts < 1 || numAccounts > 100) {
        console.error('\n❌ Invalid number of accounts. Must be between 1 and 100.');
        return;
      }
      
      // Use the same ethers v5 HDNode implementation as Kondor.
      const hdNode = HDNode.fromMnemonic(seedPhrase);
      
      console.log(`\n🔑 Derived Accounts from Seed Phrase (${numAccounts} accounts):`);
      console.log('─'.repeat(70));
      
      for (let i = 0; i < numAccounts; i++) {
        // Kondor derivation path: m/44'/659'/{accountIndex}'/0/0
        // Each account increments the account index (3rd level), not the address index
        const derivationPath = `m/44'/659'/${i}'/0/0`;
        const derived = hdNode.derivePath(derivationPath);
        
        // Create signer from the derived private key (remove '0x' prefix)
        const signer = new Signer({
          privateKey: derived.privateKey.slice(2),
        });
        
        console.log(`\n  Account #${i + 1} (${derivationPath})`);
        console.log(`    Address:     ${signer.getAddress()}`);
        console.log(`    Private Key: ${signer.getPrivateKey('wif')}`);
      }
      
      console.log('\n' + '─'.repeat(70));
      console.log('⚠️  IMPORTANT: Keep your seed phrase and private keys secure!');
      console.log('    Never share them with anyone.');
      
    } catch (error: any) {
      console.error('\n❌ Error deriving accounts:', error.message || error);
    }
  });

// Get address from private key
program
  .command('address')
  .description('Get address from a private key (WIF)')
  .argument('<privateKey>', 'Private key in WIF format')
  .action((privateKey: string) => {
    try {
      const signer = Signer.fromWif(privateKey);
      console.log(`\n📍 Address: ${signer.getAddress()}`);
    } catch (error) {
      console.error('Invalid private key format');
    }
  });

// Get account nonce
program
  .command('nonce')
  .description('Get account nonce')
  .argument('<address>', 'Koinos address')
  .action(async (address: string) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { provider } = resolved;
    
    try {
      const nonce = await provider.getNonce(address);
      console.log(`\n🔢 Nonce for ${address}: ${nonce}`);
    } catch (error) {
      console.error('Error fetching nonce:', error);
    }
  });

// Get account RC (Resource Credits)
program
  .command('rc')
  .description('Get account resource credits (mana)')
  .argument('<address>', 'Koinos address')
  .action(async (address: string) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { provider } = resolved;
    
    try {
      const rc = await provider.getAccountRc(address);
      const rcFormatted = rc ? utils.formatUnits(rc, 8) : '0';
      console.log(`\n⚡ Resource Credits for ${address}:`);
      console.log(`   ${rcFormatted} mana`);
    } catch (error) {
      console.error('Error fetching RC:', error);
    }
  });

// Read contract
program
  .command('read-contract')
  .description('Read a contract method')
  .argument('<contractId>', 'Contract address')
  .argument('<method>', 'Method name to call')
  .option('-a, --args <json>', 'Method arguments as JSON', '{}')
  .action(async (contractId: string, method: string, options: { args: string }) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { provider } = resolved;
    
    try {
      const contract = await getTokenContract(provider, contractId);
      
      const args = JSON.parse(options.args);
      const { result } = await contract.functions[method](args);
      
      console.log('\n📄 Contract Response:');
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('Error reading contract:', error);
    }
  });

// Import wallet from private key
program
  .command('import-wallet')
  .description('Import a wallet from a private key (WIF format)')
  .argument('<privateKey>', 'Private key in WIF format')
  .action((privateKey: string) => {
    try {
      const signer = Signer.fromWif(privateKey);
      const address = signer.getAddress();
      
      console.log('\n🔐 Setting up wallet encryption...');
      const password = promptNewPassword();
      
      saveWallet(privateKey, address, password);
      
      console.log('\n✅ Wallet imported and encrypted successfully!');
      console.log(`   Address: ${address}`);
      console.log(`   Stored in: ${WALLET_FILE}`);
      console.log('\n⚠️  Remember your password - it cannot be recovered!');
    } catch (error: any) {
      if (error.message === 'Passwords do not match' || error.message.includes('Password must be')) {
        console.error(`❌ ${error.message}`);
      } else {
        console.error('❌ Invalid private key format. Please provide a valid WIF key.');
      }
    }
  });

// Show current wallet
program
  .command('wallet')
  .description('Show the current wallet address')
  .action(() => {
    const walletFile = loadWalletFile();
    if (!walletFile) {
      console.log('\n❌ No wallet found. Import one with: kcli import-wallet <privateKey>');
      return;
    }
    console.log('\n👛 Current Wallet:');
    console.log(`   Address: ${walletFile.address}`);
    console.log(`   Created: ${walletFile.createdAt}`);
    console.log(`   🔐 Encrypted (password required for operations)`);
  });

// Delete wallet
program
  .command('delete-wallet')
  .description('Delete the stored wallet')
  .action(() => {
    if (deleteWallet()) {
      console.log('\n✅ Wallet deleted successfully.');
    } else {
      console.log('\n❌ No wallet found to delete.');
    }
  });

// Register block producer public key to a producer address
program
  .command('register-producer-key')
  .description('Register a block producer public key to a producer address using the PoB contract')
  .argument('<producerAddressOrPublicKey>', 'Producer address or public key (if main producer address is configured)')
  .argument('[publicKey]', 'Block producer public key in base64url format')
  .option('--dry-run', 'Show transaction details without signing or submitting')
  .option('--password-file <path>', 'Read wallet password from a local 0600 file')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (producerAddressOrPublicKey: string, publicKeyArg: string | undefined, options: { dryRun?: boolean } & WalletUnlockOptions & ConfirmationOptions) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    const pobContract = requireContract(context, 'pob', 'register-producer-key');
    if (!pobContract) return;
    const config = loadConfig();

    // Support two forms:
    // 1) kcli register-producer-key <producerAddress> <publicKey>
    // 2) kcli register-producer-key <publicKey>  (uses config.mainProducerAddress)
    const producerAddress = publicKeyArg ? producerAddressOrPublicKey : config.mainProducerAddress;
    const publicKey = publicKeyArg || producerAddressOrPublicKey;

    if (!producerAddress) {
      console.log('\n❌ No producer address available.');
      console.log('   Provide it explicitly: kcli register-producer-key <producerAddress> <publicKey>');
      console.log('   Or set it in config: kcli config --main-producer-address <address>');
      return;
    }

    if (!publicKeyArg) {
      console.log(`\nℹ️  Using configured main producer address: ${producerAddress}`);
    }

    // Check if wallet exists
    const walletFile = loadWalletFile();
    if (!walletFile) {
      console.log('\n❌ No wallet found. Import one first with: kcli import-wallet <privateKey>');
      return;
    }

    // Validate producer address
    let isValidProducerAddress = false;
    try {
      isValidProducerAddress = utils.isChecksumAddress(producerAddress);
    } catch (error) {
      isValidProducerAddress = false;
    }

    if (!isValidProducerAddress) {
      console.log('\n❌ Invalid producer address format.');
      return;
    }

    // Validate and inspect public key format
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = utils.decodeBase64url(publicKey);
    } catch (error) {
      console.log('\n❌ Invalid public key format. Expected base64url encoded key.');
      return;
    }

    if (publicKeyBytes.length !== 33 && publicKeyBytes.length !== 65) {
      console.log('\n❌ Invalid public key length.');
      console.log(`   Decoded length: ${publicKeyBytes.length} bytes`);
      console.log('   Expected: 33 bytes (compressed) or 65 bytes (uncompressed)');
      return;
    }

    // Prompt for password to unlock wallet
    console.log(`\n🔐 Unlocking wallet for address: ${walletFile.address}`);
    let password: string;
    try {
      password = getWalletPassword(options);
    } catch (error: any) {
      console.error(`❌ ${error.message}`);
      return;
    }

    let wallet;
    try {
      wallet = loadWallet(password);
      if (!wallet) {
        console.error('❌ Failed to load wallet.');
        return;
      }
    } catch (error: any) {
      console.error('❌ Invalid password. Please try again.');
      return;
    }

    if (wallet.address !== producerAddress) {
      console.log('\n⚠️  Wallet address differs from producer address.');
      console.log(`   Wallet:   ${wallet.address}`);
      console.log(`   Producer: ${producerAddress}`);
      console.log('   This transaction must be authorized by the producer address.');
    }

    try {
      const signer = Signer.fromWif(wallet.privateKey);
      signer.provider = provider;

      const pob = new Contract({
        id: pobContract,
        abi: pobAbi,
        provider,
        signer,
      });

      const { operation: registerKeyOp } = await pob.functions.register_public_key({
        producer: producerAddress,
        public_key: publicKey,
      }, { onlyOperation: true });

      const availableMana = await provider.getAccountRc(wallet.address);
      const manaValue = availableMana ? BigInt(availableMana) : BigInt(0);
      const rcLimit = manaValue > BigInt(0) ? (manaValue * BigInt(10)) / BigInt(100) : BigInt(0);

      const transaction = new Transaction({
        signer,
        provider,
        options: {
          ...(rcLimit > BigInt(0) && { rcLimit: rcLimit.toString() }),
        },
      });

      await transaction.pushOperation(registerKeyOp);
      await transaction.prepare();
      if (!assertPreparedTransactionNetwork(context, transaction)) return;

      console.log('\n🔗 Producer Key Registration Summary:');
      console.log(`   Producer Address: ${producerAddress}`);
      console.log(`   Public Key: ${publicKey}`);
      console.log(`   Public Key Bytes: ${publicKeyBytes.length}`);
      console.log(`   Signer Address: ${wallet.address}`);

      console.log('\n📝 Transaction Details (BEFORE SIGNING):');
      console.log('─'.repeat(50));
      console.log(`   Transaction ID: ${transaction.transaction.id}`);
      console.log(`   Payer: ${transaction.transaction.header?.payer}`);
      console.log(`   Nonce: ${transaction.transaction.header?.nonce}`);
      console.log(`   RC Limit: ${transaction.transaction.header?.rc_limit}`);
      console.log(`   Contract: ${registerKeyOp.call_contract?.contract_id}`);
      console.log(`   Entry Point: ${registerKeyOp.call_contract?.entry_point}`);
      console.log(`   Args (base64): ${registerKeyOp.call_contract?.args}`);
      console.log('─'.repeat(50));

      if (options.dryRun) {
        console.log('\n📋 Dry run - transaction NOT signed or submitted.');
        return;
      }

      if (!options.yes) {
        const confirm = readlineSync.question('\n⚠️  Type "REGISTER" to confirm and sign: ');
        if (confirm !== 'REGISTER') {
          console.log('\n❌ Transaction cancelled.');
          return;
        }
      }

      console.log('\n   Signing and submitting transaction...\n');
      await transaction.sign();
      const receipt = await transaction.send();

      console.log('✅ Registration transaction submitted!');
      console.log(`   Transaction ID: ${transaction.transaction.id}`);

      if (receipt) {
        if (receipt.logs && receipt.logs.length > 0) {
          console.log('   Logs:', receipt.logs);
        }
        if (receipt.events && receipt.events.length > 0) {
          console.log(`   Events: ${receipt.events.length} event(s)`);
        }
      }

      console.log('\n⏳ Waiting for transaction to be included in a block...');
      try {
        const blockInfo = await transaction.wait('byTransactionId', 60000);
        console.log(`   ✅ Transaction confirmed in block ${blockInfo?.blockNumber || 'unknown'}`);
      } catch (waitError: any) {
        console.log('   ⚠️  Could not confirm transaction (timeout). It may still be pending.');
      }
    } catch (error: any) {
      console.error('\n❌ Error registering producer key:');
      if (error.message) {
        console.error(`   Message: ${error.message}`);
      }
      if (error.code) {
        console.error(`   Code: ${error.code}`);
      }
      if (error.logs && error.logs.length > 0) {
        console.error(`   Logs: ${JSON.stringify(error.logs)}`);
      }
      if (error.receipt) {
        console.error(`   Receipt: ${JSON.stringify(error.receipt, null, 2)}`);
      }
    }
  });

// Get block producer public key registered to a producer address
program
  .command('get-producer-key')
  .description('Get the block producer public key registered to a producer address')
  .argument('[producerAddress]', 'Producer address (optional, uses main producer address from config if omitted)')
  .action(async (producerAddressArg?: string) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    const pobContract = requireContract(context, 'pob', 'get-producer-key');
    if (!pobContract) return;
    const config = loadConfig();

    const producerAddress = producerAddressArg || config.mainProducerAddress;

    if (!producerAddress) {
      console.log('\n❌ No producer address available.');
      console.log('   Usage: kcli get-producer-key <producerAddress>');
      console.log('   Or set it in config: kcli config --main-producer-address <address>');
      return;
    }

    // Validate producer address
    let isValidProducerAddress = false;
    try {
      isValidProducerAddress = utils.isChecksumAddress(producerAddress);
    } catch (error) {
      isValidProducerAddress = false;
    }

    if (!isValidProducerAddress) {
      console.log('\n❌ Invalid producer address format.');
      return;
    }

    try {
      const pob = new Contract({
        id: pobContract,
        abi: pobAbi,
        provider,
      });

      const { result } = await pob.functions.get_public_key({
        producer: producerAddress,
      });

      const registeredKey = result?.value as string | undefined;

      if (!registeredKey) {
        console.log('\nℹ️  No producer public key registered for this address.');
        console.log(`   Producer Address: ${producerAddress}`);
        return;
      }

      console.log('\n🔑 Registered Producer Public Key:');
      console.log(`   Producer Address: ${producerAddress}`);
      console.log(`   Public Key: ${registeredKey}`);

      try {
        const keyBytes = utils.decodeBase64url(registeredKey);
        console.log(`   Key Length: ${keyBytes.length} bytes`);
      } catch (error) {
        // Ignore decode errors here; key is still shown as returned by contract
      }
    } catch (error: any) {
      console.error('\n❌ Error retrieving producer public key:');
      if (error.message) {
        console.error(`   Message: ${error.message}`);
      }
      if (error.code) {
        console.error(`   Code: ${error.code}`);
      }
    }
  });

// Interactive dashboard for active block producers
program
  .command('producer-dashboard')
  .description('Interactive text dashboard showing active block producers and peers')
  .option('-w, --window <blocks>', 'Number of recent blocks to analyze', '120')
  .option('-i, --interval <seconds>', 'Screen and producer activity refresh interval in seconds', '5')
  .option('-t, --top <count>', 'Number of producers to display', '20')
  .option('-v, --view <view>', 'Initial dashboard view: producers or peers', 'producers')
  .option('--balance-interval <seconds>', 'Balance and supply polling interval (1-3600 seconds)', '30')
  .option('--pool-interval <seconds>', 'Pool polling interval (1-86400 seconds)', '600')
  .option('--rpc-concurrency <count>', 'Maximum dashboard RPC requests and sockets (1-4)', '2')
  .option('--rpc-timeout <seconds>', 'Timeout per RPC attempt (1-60 seconds)', '10')
  .option('--rpc-retries <count>', 'Additional attempts for recoverable reads (0-3)', '2')
  .option('--rpc-stats', 'Show cumulative dashboard RPC counters')
  .action(async (options: { window?: string; interval?: string; top?: string; view?: string;
    balanceInterval: string; poolInterval: string; rpcConcurrency: string; rpcTimeout: string; rpcRetries: string; rpcStats?: boolean }) => {
    let context: NetworkContext;
    let balanceInterval: number, poolInterval: number, concurrency: number, timeoutMs: number, retries: number;
    try {
      context = resolveNetworkContext();
      balanceInterval = parseDashboardInteger(options.balanceInterval, '--balance-interval', 3600) * 1000;
      poolInterval = parseDashboardInteger(options.poolInterval, '--pool-interval', 86400) * 1000;
      concurrency = parseDashboardInteger(options.rpcConcurrency, '--rpc-concurrency', 4);
      timeoutMs = parseDashboardInteger(options.rpcTimeout, '--rpc-timeout', 60) * 1000;
      if (!/^[0-3]$/.test(options.rpcRetries)) throw new Error('--rpc-retries must be an integer from 0 to 3');
      retries = Number(options.rpcRetries);
    } catch (error: any) { console.error(error.message); process.exitCode = 1; return; }
    const koinContract = requireContract(context, 'koin', 'producer-dashboard');
    const vhpContract = requireContract(context, 'vhp', 'producer-dashboard');
    if (!koinContract || !vhpContract) return;

    type DashboardView = 'producers' | 'peers';
    type PeerSource = 'lsof' | 'netstat';

    interface PeerConnection {
      key: string;
      host: string;
      port: number;
      endpoint: string;
      source: PeerSource;
    }

    interface PeerConfigData {
      sourcePath: string;
      listenPorts: Set<number>;
      seedHosts: Set<string>;
      seedIps: Set<string>;
      seedEndpoints: Set<string>;
    }

    const windowSize = parseInt(options.window || '120', 10);
    const refreshSeconds = parseInt(options.interval || '5', 10);
    const topCount = parseInt(options.top || '20', 10);
    const initialView = (options.view || 'producers').toLowerCase();

    if (!Number.isFinite(windowSize) || windowSize < 1) {
      console.log('\n❌ Invalid --window value. Must be a positive integer.');
      return;
    }
    if (!Number.isFinite(refreshSeconds) || refreshSeconds < 1) {
      console.log('\n❌ Invalid --interval value. Must be a positive integer.');
      return;
    }
    if (!Number.isFinite(topCount) || topCount < 1) {
      console.log('\n❌ Invalid --top value. Must be a positive integer.');
      return;
    }
    if (initialView !== 'producers' && initialView !== 'peers') {
      console.log('\n❌ Invalid --view value. Use "producers" or "peers".');
      return;
    }

    let provider: DashboardProvider;
    try { provider = new DashboardProvider(context.rpc, { concurrency, timeoutMs, retries }); }
    catch (error: any) { console.error(error.message); process.exitCode = 1; return; }
    // Keep this read-only preflight independent of unpublished transaction-network changes.
    const expectedChainId = context.definition.chainId ?? (context.networkName === 'mainnet'
      ? 'EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==' : undefined);
    const producerData = new DashboardProducerData(provider, `${context.networkName}:${expectedChainId || ''}`,
      koinContract, vhpContract, balanceInterval, poolInterval, Date.now, 150, concurrency);

    let currentView = initialView as DashboardView;
    let stopped = false;
    let refreshing = false;
    let timer: NodeJS.Timeout | undefined;
    let stdinRawEnabled = false;
    let peerConfigWarning = '';
    let peerSamples = 0;
    let stdinHandler: ((chunk: string | Buffer) => void) | undefined;
    let dataTimer: NodeJS.Timeout | undefined;
    let activityInFlight = false;
    let activityUpdatedAt: number | undefined;
    let activityError = '';
    let networkVerified = false;
    let activity: { headHeight: number; startHeight: number; latestBlockTimestamp: number; fetchedBlocks: number;
      ranking: Array<[string, { count: number; lastHeight: number }]> } | undefined;
    const geolocationCache = new Map<string, { value: string; checkedAt: number }>();
    const geolocationInFlight = new Map<string, Promise<string>>();
    const pingCache = new Map<string, { value: string; checkedAt: number }>();
    const pingInFlight = new Map<string, Promise<string>>();
    const peerSeenCounter = new Map<string, number>();
    const peerConfigData: PeerConfigData = {
      sourcePath: '',
      listenPorts: new Set<number>([8888]),
      seedHosts: new Set<string>(),
      seedIps: new Set<string>(),
      seedEndpoints: new Set<string>(),
    };
    const GEOLOCATION_TTL_MS = 12 * 60 * 60 * 1000;
    const PING_TTL_MS = 20 * 1000;
    const MAX_BLOCKS_PER_BLOCK_STORE_REQUEST = 1000;

    const stopDashboard = () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      if (dataTimer) clearInterval(dataTimer);
      producerData.cache.close();
      provider.close();
      if (stdinHandler) {
        process.stdin.off('data', stdinHandler);
      }
      if (process.stdin.isTTY && stdinRawEnabled) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      console.log('\nDashboard stopped.');
      process.exit(0);
    };

    process.on('SIGINT', stopDashboard);
    process.on('SIGTERM', stopDashboard);

    const formatCell = (value: string, width: number): string => {
      if (value.length <= width) return value.padStart(width);
      return `${value.slice(0, width - 3)}...`;
    };

    const formatLeftCell = (value: string, width: number): string => {
      if (value.length <= width) return value.padEnd(width);
      return `${value.slice(0, width - 3)}...`;
    };

    const isValidAddress = (address: string): boolean => {
      try {
        return utils.isChecksumAddress(address);
      } catch (error) {
        return false;
      }
    };

    const normalizeHost = (value: string): string => {
      const trimmed = value.trim().replace(/^\[|\]$/g, '');
      const percentIndex = trimmed.indexOf('%');
      const withoutInterface = percentIndex >= 0 ? trimmed.slice(0, percentIndex) : trimmed;
      return withoutInterface.toLowerCase();
    };

    const parseEndpointToken = (value: string): { host: string; port: number } | null => {
      const token = value.trim();
      if (!token) return null;

      const multiaddrMatch = token.match(/\/(?:ip4|ip6|dns4|dns6|dns)\/([^/]+)\/tcp\/(\d+)/i);
      if (multiaddrMatch) {
        const host = normalizeHost(multiaddrMatch[1]);
        const port = parseInt(multiaddrMatch[2], 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
          return { host, port };
        }
        return null;
      }

      const bracketMatch = token.match(/^\[([^\]]+)\]:(\d+)$/);
      if (bracketMatch) {
        const host = normalizeHost(bracketMatch[1]);
        const port = parseInt(bracketMatch[2], 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
          return { host, port };
        }
        return null;
      }

      const colonMatch = token.match(/^(.+):(\d+)$/);
      if (colonMatch) {
        const host = normalizeHost(colonMatch[1]);
        const port = parseInt(colonMatch[2], 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
          return { host, port };
        }
        return null;
      }

      const dotPortMatch = token.match(/^(.+)\.(\d+)$/);
      if (dotPortMatch) {
        const host = normalizeHost(dotPortMatch[1]);
        const port = parseInt(dotPortMatch[2], 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
          return { host, port };
        }
      }

      return null;
    };

    const formatPeerEndpoint = (host: string, port: number): string => {
      if (net.isIP(host) === 6) {
        return `[${host}]:${port}`;
      }
      return `${host}:${port}`;
    };

    const isLoopbackHost = (host: string): boolean => {
      const normalized = normalizeHost(host);
      if (!normalized) return true;
      if (normalized === 'localhost') return true;
      if (normalized === '0.0.0.0' || normalized === '::') return true;

      const ipType = net.isIP(normalized);
      if (ipType === 4) {
        return normalized.startsWith('127.');
      }
      if (ipType === 6) {
        return normalized === '::1';
      }
      return false;
    };

    const isPrivateIp = (host: string): boolean => {
      const normalized = normalizeHost(host);
      const ipType = net.isIP(normalized);

      if (ipType === 4) {
        if (normalized.startsWith('10.')) return true;
        if (normalized.startsWith('127.')) return true;
        if (normalized.startsWith('192.168.')) return true;
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
        return false;
      }

      if (ipType === 6) {
        if (normalized === '::1') return true;
        if (normalized.startsWith('fe80:')) return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
        return false;
      }

      return false;
    };

    const addSeedEndpoint = (host: string, port: number): void => {
      const normalizedHost = normalizeHost(host);
      if (!normalizedHost || !Number.isFinite(port) || port < 1 || port > 65535) {
        return;
      }
      peerConfigData.listenPorts.add(port);
      peerConfigData.seedHosts.add(normalizedHost);
      if (net.isIP(normalizedHost)) {
        peerConfigData.seedIps.add(normalizedHost);
      }
      peerConfigData.seedEndpoints.add(`${normalizedHost}|${port}`);
    };

    const loadPeerConfig = async (): Promise<void> => {
      const candidates = Array.from(new Set([
        process.env.KOINOS_CONFIG_PATH,
        process.env.KOINOS_BASEDIR ? path.join(process.env.KOINOS_BASEDIR, 'config', 'config.yml') : undefined,
        path.join(os.homedir(), '.koinos', 'config', 'config.yml'),
        path.join(os.homedir(), '.koinos', 'config.yml'),
        '/etc/koinos/config.yml',
      ].filter((candidate): candidate is string => Boolean(candidate))));

      const selectedPath = candidates.find((candidate) => fs.existsSync(candidate));
      if (!selectedPath) {
        return;
      }

      peerConfigData.sourcePath = selectedPath;

      let configContent = '';
      try {
        configContent = fs.readFileSync(selectedPath, 'utf8');
      } catch (error) {
        peerConfigWarning = `Could not read peer config at ${selectedPath}.`;
        return;
      }

      const seedEntries: Array<{ host: string; port: number }> = [];
      const lines = configContent.split(/\r?\n/);
      let inP2pSection = false;

      for (const rawLine of lines) {
        const withoutComment = rawLine.split('#')[0];
        if (!withoutComment.trim()) continue;

        if (/^\S/.test(rawLine)) {
          inP2pSection = withoutComment.trim() === 'p2p:';
          continue;
        }

        if (!inP2pSection) continue;
        const trimmed = withoutComment.trim();

        const listenMatch = trimmed.match(/^listen:\s*(.+)$/);
        if (listenMatch) {
          const listenValue = listenMatch[1].trim();
          const listenPortMatch = listenValue.match(/\/tcp\/(\d+)/);
          if (listenPortMatch) {
            const listenPort = parseInt(listenPortMatch[1], 10);
            if (Number.isFinite(listenPort) && listenPort > 0 && listenPort <= 65535) {
              peerConfigData.listenPorts.add(listenPort);
            }
          } else {
            const parsedListen = parseEndpointToken(listenValue);
            if (parsedListen) {
              peerConfigData.listenPorts.add(parsedListen.port);
            }
          }
          continue;
        }

        const peerMatch = trimmed.match(/^-\s*(.+)$/);
        if (peerMatch) {
          const parsedPeer = parseEndpointToken(peerMatch[1].trim());
          if (parsedPeer) {
            seedEntries.push({ host: parsedPeer.host, port: parsedPeer.port });
          }
        }
      }

      await Promise.all(seedEntries.map(async (entry) => {
        addSeedEndpoint(entry.host, entry.port);
        if (net.isIP(entry.host)) return;

        try {
          const resolved = await dnsLookup(entry.host, { all: true });
          resolved.forEach((resolvedEntry) => {
            addSeedEndpoint(resolvedEntry.address, entry.port);
          });
        } catch (error) {
          // Ignore lookup failures; we still retain hostname-based matching.
        }
      }));
    };

    const shouldIncludeConnection = (commandName: string, localPort: number, remotePort: number): boolean => {
      const hasKnownP2pPort = peerConfigData.listenPorts.has(localPort) || peerConfigData.listenPorts.has(remotePort);
      const isKoinosProcess = /(koinos|block[-_]?producer|koinosd|p2p)/i.test(commandName);
      return hasKnownP2pPort || isKoinosProcess;
    };

    const buildPeerConnection = (host: string, port: number, source: PeerSource): PeerConnection | null => {
      const normalizedHost = normalizeHost(host);
      if (!normalizedHost || isLoopbackHost(normalizedHost)) {
        return null;
      }

      return {
        key: `${normalizedHost}|${port}`,
        host: normalizedHost,
        port,
        endpoint: formatPeerEndpoint(normalizedHost, port),
        source,
      };
    };

    const collectPeersFromLsof = (): PeerConnection[] => {
      try {
        const output = execSync('lsof -nP -iTCP -sTCP:ESTABLISHED', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = output.split(/\r?\n/).slice(1);
        const peers = new Map<string, PeerConnection>();

        for (const line of lines) {
          if (!line.includes(' TCP ') || !line.includes('->')) continue;

          const commandName = (line.trim().split(/\s+/)[0] || '').toLowerCase();
          const tcpIndex = line.indexOf(' TCP ');
          if (tcpIndex < 0) continue;

          const connectionValue = line
            .slice(tcpIndex + 5)
            .replace(/\s+\(ESTABLISHED\)\s*$/, '')
            .trim();

          const parts = connectionValue.split('->');
          if (parts.length !== 2) continue;

          const local = parseEndpointToken(parts[0]);
          const remote = parseEndpointToken(parts[1]);
          if (!local || !remote) continue;
          if (!shouldIncludeConnection(commandName, local.port, remote.port)) continue;

          const peer = buildPeerConnection(remote.host, remote.port, 'lsof');
          if (!peer) continue;
          peers.set(peer.key, peer);
        }

        return Array.from(peers.values());
      } catch (error) {
        return [];
      }
    };

    const collectPeersFromNetstat = (): PeerConnection[] => {
      try {
        const output = execSync('netstat -an', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = output.split(/\r?\n/);
        const peers = new Map<string, PeerConnection>();

        for (const line of lines) {
          if (!/ESTABLISHED/i.test(line)) continue;

          const connectionMatch = line.match(/^\s*tcp\S*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+ESTABLISHED/i);
          if (!connectionMatch) continue;

          const local = parseEndpointToken(connectionMatch[1]);
          const remote = parseEndpointToken(connectionMatch[2]);
          if (!local || !remote) continue;
          if (!shouldIncludeConnection('netstat', local.port, remote.port)) continue;

          const peer = buildPeerConnection(remote.host, remote.port, 'netstat');
          if (!peer) continue;
          if (!peers.has(peer.key)) {
            peers.set(peer.key, peer);
          }
        }

        return Array.from(peers.values());
      } catch (error) {
        return [];
      }
    };

    const collectActivePeers = (): { peers: PeerConnection[]; source: string } => {
      const combined = new Map<string, PeerConnection>();
      const sourceParts: string[] = [];

      const lsofPeers = collectPeersFromLsof();
      if (lsofPeers.length > 0) {
        sourceParts.push('lsof');
        lsofPeers.forEach((peer) => combined.set(peer.key, peer));
      }

      const netstatPeers = collectPeersFromNetstat();
      if (netstatPeers.length > 0) {
        sourceParts.push('netstat');
        netstatPeers.forEach((peer) => {
          if (!combined.has(peer.key)) {
            combined.set(peer.key, peer);
          }
        });
      }

      const source = sourceParts.length > 0 ? sourceParts.join('+') : 'none';
      return { peers: Array.from(combined.values()), source };
    };

    const fetchGeolocation = async (host: string): Promise<string> => {
      if (net.isIP(host) === 0) return 'n/a';
      if (isPrivateIp(host)) return 'Private/Local';

      return new Promise((resolve) => {
        let settled = false;
        const finish = (value: string) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        const req = https.get(`https://ipwho.is/${encodeURIComponent(host)}`, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as {
                success?: boolean;
                city?: string;
                region?: string;
                country?: string;
              };

              if (parsed.success === false) {
                finish('Unknown');
                return;
              }

              const location = [parsed.city, parsed.region, parsed.country]
                .filter((value): value is string => Boolean(value && value.trim()))
                .join(', ');

              finish(location || 'Unknown');
            } catch (error) {
              finish('Unknown');
            }
          });
        });

        req.on('error', () => finish('Unknown'));
        req.setTimeout(2500, () => {
          req.destroy();
          finish('Unknown');
        });
      });
    };

    const getGeolocation = async (host: string): Promise<string> => {
      const now = Date.now();
      const cached = geolocationCache.get(host);
      if (cached && now - cached.checkedAt < GEOLOCATION_TTL_MS) {
        return cached.value;
      }

      const inFlight = geolocationInFlight.get(host);
      if (inFlight) return inFlight;

      const lookupPromise = fetchGeolocation(host)
        .then((value) => {
          geolocationCache.set(host, { value, checkedAt: Date.now() });
          return value;
        })
        .finally(() => {
          geolocationInFlight.delete(host);
        });

      geolocationInFlight.set(host, lookupPromise);
      return lookupPromise;
    };

    const fetchPingSeconds = async (host: string, port: number): Promise<string> => {
      if (!Number.isFinite(port) || port < 1 || port > 65535) return 'n/a';

      return new Promise((resolve) => {
        const startedAt = Date.now();
        const socket = net.createConnection({ host, port });
        let settled = false;

        const finish = (value: string) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(value);
        };

        socket.setTimeout(2500);
        socket.once('connect', () => {
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          finish(elapsedSeconds.toFixed(3));
        });
        socket.once('timeout', () => finish('timeout'));
        socket.once('error', () => finish('n/a'));
      });
    };

    const getPingSeconds = async (host: string, port: number): Promise<string> => {
      const cacheKey = `${host}|${port}`;
      const now = Date.now();
      const cached = pingCache.get(cacheKey);

      if (cached && now - cached.checkedAt < PING_TTL_MS) {
        return cached.value;
      }

      const inFlight = pingInFlight.get(cacheKey);
      if (inFlight) return inFlight;

      const pingPromise = fetchPingSeconds(host, port)
        .then((value) => {
          pingCache.set(cacheKey, { value, checkedAt: Date.now() });
          return value;
        })
        .finally(() => {
          pingInFlight.delete(cacheKey);
        });

      pingInFlight.set(cacheKey, pingPromise);
      return pingPromise;
    };

    const classifyPeerRole = (peer: PeerConnection, seenPercent: number, pingSeconds: string): string => {
      if (peerConfigData.seedEndpoints.has(peer.key) || peerConfigData.seedIps.has(peer.host) || peerConfigData.seedHosts.has(peer.host)) {
        return 'Seed';
      }

      const pingValue = Number.parseFloat(pingSeconds);
      const lowLatency = Number.isFinite(pingValue) && pingValue <= 0.35;
      const stable = seenPercent >= 70;
      const moderate = seenPercent >= 45;

      if (stable && lowLatency) return 'Likely Producer';
      if (moderate && lowLatency) return 'Possible Producer';
      return 'Relay/Unknown';
    };

    const fetchBlocksByHeightPaged = async (headBlockId: string, startHeight: number, endHeight: number): Promise<any[]> => {
      const allItems: any[] = [];
      let nextStartHeight = startHeight;

      while (nextStartHeight <= endHeight) {
        const remainingBlocks = endHeight - nextStartHeight + 1;
        const chunkSize = Math.min(MAX_BLOCKS_PER_BLOCK_STORE_REQUEST, remainingBlocks);

        const chunkResponse = await provider.call<{ block_items: any[] }>('block_store.get_blocks_by_height', {
          head_block_id: headBlockId,
          ancestor_start_height: nextStartHeight,
          num_blocks: chunkSize,
          return_block: true,
          return_receipt: false,
        });

        const chunkItems = chunkResponse.block_items || [];
        if (!chunkItems.length) {
          break;
        }

        allItems.push(...chunkItems);

        if (chunkItems.length < chunkSize) {
          break;
        }

        nextStartHeight += chunkSize;
      }

      return allItems;
    };

    const refreshProducerActivity = async (): Promise<void> => {
      if (activityInFlight || stopped) return;
      activityInFlight = true;
      try {
        if (!networkVerified) {
          const chainId = await provider.getChainId();
          if (expectedChainId && chainId !== expectedChainId) {
            throw new Error('RPC chain does not match selected network');
          }
          networkVerified = true;
        }
        const headInfo = await provider.getHeadInfo();
        const headHeight = parseInt(headInfo.head_topology?.height || '0', 10);
        const headBlockId = headInfo.head_topology?.id;

        if (!headBlockId || !headHeight) {
          throw new Error('Unable to retrieve head block information');
        }

        const startHeight = Math.max(1, headHeight - windowSize + 1);
        const items = await fetchBlocksByHeightPaged(headBlockId, startHeight, headHeight);
        const stats = new Map<string, { count: number; lastHeight: number }>();
        let latestBlockTimestamp = 0;

        for (const item of items) {
          const signer = item?.block?.header?.signer || 'unknown';
          const blockHeight = parseInt(item?.block_height || '0', 10);
          const timestamp = parseInt(item?.block?.header?.timestamp || '0', 10);

          if (timestamp > latestBlockTimestamp) {
            latestBlockTimestamp = timestamp;
          }

          const current = stats.get(signer);
          if (current) {
            current.count += 1;
            if (blockHeight > current.lastHeight) {
              current.lastHeight = blockHeight;
            }
          } else {
            stats.set(signer, { count: 1, lastHeight: blockHeight });
          }
        }

        const ranking = Array.from(stats.entries()).sort((a, b) => {
          if (b[1].count !== a[1].count) return b[1].count - a[1].count;
          return b[1].lastHeight - a[1].lastHeight;
        });
        if (stopped) return;
        activity = { headHeight, startHeight, latestBlockTimestamp, fetchedBlocks: items.length, ranking };
        activityUpdatedAt = Date.now();
        activityError = '';
        if (currentView === 'producers') producerData.select(ranking.map(([owner]) => owner).filter(isValidAddress),
          ranking.slice(0, topCount).map(([owner]) => owner).filter(isValidAddress));
      } catch (error) {
        activityError = !networkVerified && error instanceof Error && error.message === 'RPC chain does not match selected network'
          ? error.message : dashboardError(error);
      } finally { activityInFlight = false; }
    };

    const drawProducerView = (): void => {
      void refreshProducerActivity();
      process.stdout.write('\x1Bc');
      console.log('📊 Koinos Producer Dashboard (Ctrl+C or q to exit)');
      console.log('─'.repeat(156));
      console.log(' View: PRODUCERS | Press 1=producers 2=peers q=quit');
      console.log(` RPC: ${context.rpc}`);
      console.log(` Updated: ${new Date().toISOString()}`);
      if (activityError) console.log(` Warning: ${activityError}; ${activity ? `activity stale:${dashboardAge(Date.now() - activityUpdatedAt!)}` : 'activity n/a'}`);
      if (!activity) {
        console.log(' Head / producer activity: n/a (awaiting RPC)');
      } else {
        const { headHeight, startHeight, latestBlockTimestamp, fetchedBlocks, ranking } = activity;
        const producers = ranking.map(([owner]) => owner);
        const visible = ranking.slice(0, topCount).map(([owner]) => owner);
        const koinSupply = producerData.supply('koin');
        const vhpSupply = producerData.supply('vhp');
        const virtualSupply = { value: koinSupply.value === undefined || vhpSupply.value === undefined ? undefined : koinSupply.value + vhpSupply.value,
          stale: koinSupply.stale || vhpSupply.stale, ageMs: Math.max(koinSupply.ageMs ?? 0, vhpSupply.ageMs ?? 0), loading: koinSupply.loading || vhpSupply.loading };
        const activityAge = Date.now() - activityUpdatedAt!;
        const activityStale = !!activityError || activityAge >= refreshSeconds * 1000;
        const apy = producerData.apy(producers);
        if (activityStale) { apy.stale = true; apy.ageMs = Math.max(apy.ageMs ?? 0, activityAge); }
        console.log(` Head Block: ${headHeight} | Activity ${activityStale ? 'stale:' : 'age: '}${dashboardAge(activityAge)}`);
        if (latestBlockTimestamp > 0) console.log(` Last Block Time: ${new Date(latestBlockTimestamp).toISOString()}`);
        console.log(` Window: ${startHeight} → ${headHeight} (${fetchedBlocks} blocks) | Active Producers: ${ranking.length}`);
        console.log(` Total KOIN Supply: ${dashboardValue(koinSupply, dashboardWholeUnits, 48)}`);
        console.log(` Total VHP Supply: ${dashboardValue(vhpSupply, dashboardWholeUnits, 48)}`);
        console.log(` Total Virtual Supply (VHP + KOIN): ${dashboardValue(virtualSupply, dashboardWholeUnits, 48)}`);
        console.log(` Estimated APY (active window): ${dashboardValue(apy, value => `${value}%`, 48)}`);
        for (const warning of producerData.warnings(producers, visible)) console.log(` Warning: ${warning}`);
        const ages = visible.flatMap(owner => [producerData.balance('koin', owner), producerData.balance('vhp', owner)])
          .flatMap(read => read.ageMs === undefined ? [] : [read.ageMs]);
        console.log(` Oldest available balance: ${ages.length ? dashboardAge(Math.max(...ages)) : 'n/a'}`);
        console.log('─'.repeat(156));
        console.log(` ${'#'.padEnd(3)} ${'Producer'.padEnd(36)} ${'Pool'.padEnd(24)} ${'Blocks'.padStart(8)} ${'Share'.padStart(8)} ${'Last Seen'.padStart(10)} ${'KOIN'.padStart(24)} ${'VHP'.padStart(24)}`);
        if (!ranking.length) console.log(' No producer activity found in this window.');
        ranking.slice(0, topCount).forEach(([producer, data], index) => {
          const pool = producerData.pool(producer);
          const producerDisplay = pool.value ? `${ANSI_ORANGE}${producer.padEnd(36)}${ANSI_RESET}` : producer.padEnd(36);
          const poolName = dashboardValue(pool, value => value.name);
          const koinBalance = dashboardValue(producerData.balance('koin', producer), dashboardWholeUnits);
          const vhpBalance = dashboardValue(producerData.balance('vhp', producer), dashboardWholeUnits);
          const share = fetchedBlocks ? ((data.count / fetchedBlocks) * 100).toFixed(2) : '0.00';
          console.log(` ${(index + 1).toString().padEnd(3)} ${producerDisplay} ${formatLeftCell(poolName, 24)} ${data.count.toString().padStart(8)} ${`${share}%`.padStart(8)} ${`${Math.max(0, headHeight - data.lastHeight)} ago`.padStart(10)} ${formatCell(koinBalance, 24)} ${formatCell(vhpBalance, 24)}`);
        });
      }
      console.log('─'.repeat(156));
      console.log(` Screen/activity ${refreshSeconds}s | Balances/supply ${balanceInterval / 1000}s | Pools ${poolInterval / 1000}s | RPC limit ${concurrency}`);
      if (options.rpcStats) console.log(` RPC stats: ${JSON.stringify(provider.metrics)}`);
    };

    const drawPeersView = async (): Promise<void> => {
      const now = new Date();
      const { peers, source } = collectActivePeers();
      peerSamples += 1;

      const seenThisRound = new Set<string>();
      peers.forEach((peer) => {
        seenThisRound.add(peer.key);
      });
      seenThisRound.forEach((peerKey) => {
        peerSeenCounter.set(peerKey, (peerSeenCounter.get(peerKey) || 0) + 1);
      });

      const rows = await Promise.all(peers.map(async (peer) => {
        const [location, pingSeconds] = await Promise.all([
          getGeolocation(peer.host),
          getPingSeconds(peer.host, peer.port),
        ]);
        const seenCount = peerSeenCounter.get(peer.key) || 0;
        const seenPercent = peerSamples > 0 ? (seenCount / peerSamples) * 100 : 0;
        const role = classifyPeerRole(peer, seenPercent, pingSeconds);

        return {
          peer,
          location,
          pingSeconds,
          seenPercent,
          role,
        };
      }));

      rows.sort((a, b) => {
        if (b.seenPercent !== a.seenPercent) {
          return b.seenPercent - a.seenPercent;
        }
        return a.peer.endpoint.localeCompare(b.peer.endpoint);
      });

      const visibleRows = rows.slice(0, topCount);

      process.stdout.write('\x1Bc');
      console.log('📊 Koinos Producer Dashboard (Ctrl+C or q to exit)');
      console.log('─'.repeat(150));
      console.log(' View: PEERS | Press 1=producers 2=peers q=quit');
      console.log(` RPC: ${context.rpc}`);
      console.log(` Updated: ${now.toISOString()}`);
      console.log(` Active Peers: ${peers.length}`);
      console.log(` Peer Discovery Source: ${source}`);
      if (peerConfigData.sourcePath) {
        console.log(` Seed Config: ${peerConfigData.sourcePath}`);
      }
      if (peerConfigWarning) {
        console.log(` ⚠️  ${peerConfigWarning}`);
      }
      console.log('─'.repeat(150));
      console.log(` ${'#'.padEnd(3)} ${'Peer'.padEnd(32)} ${'Location'.padEnd(44)} ${'Ping(s)'.padStart(10)} ${'Seen'.padStart(8)} ${'Role'.padEnd(18)} ${'Source'.padEnd(8)}`);
      console.log('─'.repeat(150));

      if (!visibleRows.length) {
        console.log(' No active peers detected from local sockets. Verify that your local node is running and exposing p2p connections.');
      } else {
        visibleRows.forEach((row, index) => {
          const seenLabel = `${row.seenPercent.toFixed(0)}%`;
          console.log(
            ` ${(index + 1).toString().padEnd(3)} ${formatLeftCell(row.peer.endpoint, 32)} ${formatLeftCell(row.location, 44)} ${formatCell(row.pingSeconds, 10)} ${formatCell(seenLabel, 8)} ${formatLeftCell(row.role, 18)} ${formatLeftCell(row.peer.source, 8)}`
          );
        });
      }

      console.log('─'.repeat(150));
      console.log(` Refresh every ${refreshSeconds}s | Window size ${windowSize} blocks | Showing top ${topCount}`);
      console.log(' Heuristic role: Seed = configured seed peer; Likely/Possible Producer = stable low-latency peer; otherwise Relay/Unknown.');
    };

    const draw = async () => {
      if (refreshing || stopped) return;
      refreshing = true;
      try {
        if (currentView === 'peers') {
          await drawPeersView();
        } else {
          await drawProducerView();
        }
      } finally {
        refreshing = false;
      }
    };

    const enableKeyboardControls = () => {
      if (!process.stdin.isTTY) {
        return;
      }

      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      stdinRawEnabled = true;

      stdinHandler = (chunk: string | Buffer) => {
        const key = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

        if (key === '\u0003') {
          stopDashboard();
          return;
        }

        const normalized = key.trim().toLowerCase();
        if (normalized === 'q') {
          stopDashboard();
          return;
        }

        if (normalized === '1' && currentView !== 'producers') {
          currentView = 'producers';
          if (activity) producerData.select(activity.ranking.map(([owner]) => owner).filter(isValidAddress),
            activity.ranking.slice(0, topCount).map(([owner]) => owner).filter(isValidAddress));
          void draw();
          return;
        }

        if (normalized === '2' && currentView !== 'peers') {
          currentView = 'peers';
          producerData.cache.setWanted([]);
          void draw();
        }
      };

      process.stdin.on('data', stdinHandler);
    };

    await loadPeerConfig();
    enableKeyboardControls();
    dataTimer = setInterval(() => producerData.cache.tick(), 100);
    await draw();
    timer = setInterval(() => {
      void draw();
    }, refreshSeconds * 1000);
  });

// Burn KOIN (converts to VHP)
program
  .command('burn')
  .description('Burn KOIN to convert to VHP (specify amount or percentage)')
  .option('-p, --percent <number>', 'Percentage of KOIN to burn')
  .option('-a, --amount <number>', 'Exact amount of KOIN to burn')
  .option('--dry-run', 'Show what would be burned without executing')
  .option('--password-file <path>', 'Read wallet password from a local 0600 file')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options: { percent?: string; amount?: string; dryRun?: boolean } & WalletUnlockOptions & ConfirmationOptions) => {
    const resolved = createProviderFromOptions();
    if (!resolved) return;
    const { context, provider } = resolved;
    const koinContract = requireContract(context, 'koin', 'burn');
    const vhpContract = requireContract(context, 'vhp', 'burn');
    const pobContract = requireContract(context, 'pob', 'burn');
    if (!koinContract || !vhpContract || !pobContract) return;
    
    // Check if wallet exists
    const walletFile = loadWalletFile();
    if (!walletFile) {
      console.log('\n❌ No wallet found. Import one first with: kcli import-wallet <privateKey>');
      return;
    }
    
    // Validate options
    if (!options.percent && !options.amount) {
      console.error('❌ Please specify either --percent (-p) or --amount (-a)');
      console.error('   Examples:');
      console.error('     kcli burn -p 95      # Burn 95% of KOIN balance');
      console.error('     kcli burn -a 10     # Burn exactly 10 KOIN');
      return;
    }
    
    if (options.percent && options.amount) {
      console.error('❌ Cannot specify both --percent and --amount. Choose one.');
      return;
    }
    
    let percent: number | undefined;
    let exactAmount: number | undefined;
    
    if (options.percent) {
      percent = parseFloat(options.percent);
      if (isNaN(percent) || percent <= 0 || percent > 100) {
        console.error('❌ Invalid percentage. Must be between 0 and 100.');
        return;
      }
    }
    
    if (options.amount) {
      exactAmount = parseFloat(options.amount);
      if (isNaN(exactAmount) || exactAmount <= 0) {
        console.error('❌ Invalid amount. Must be a positive number.');
        return;
      }
    }
    
    // Prompt for password to unlock wallet
    console.log(`\n🔐 Unlocking wallet for address: ${walletFile.address}`);
    let password: string;
    try {
      password = getWalletPassword(options);
    } catch (error: any) {
      console.error(`❌ ${error.message}`);
      return;
    }
    
    let wallet;
    try {
      wallet = loadWallet(password);
      if (!wallet) {
        console.error('❌ Failed to load wallet.');
        return;
      }
    } catch (error: any) {
      console.error('❌ Invalid password. Please try again.');
      return;
    }
    
    try {
      const signer = Signer.fromWif(wallet.privateKey);
      signer.provider = provider;
      
      // Get KOIN contract
      const koin = new Contract({
        id: koinContract,
        abi: tokenAbi,
        provider,
        signer,
      });
      
      // Get current balance
      const { result: balanceResult } = await koin.functions.balance_of({ owner: wallet.address });
      const currentBalance = balanceResult?.value ? BigInt(balanceResult.value) : BigInt(0);
      const currentFormatted = utils.formatUnits(currentBalance.toString(), 8);
      
      if (currentBalance === BigInt(0)) {
        console.log('\n❌ No KOIN balance to burn.');
        return;
      }
      
      // Check available mana
      const availableMana = await provider.getAccountRc(wallet.address);
      const manaValue = availableMana ? BigInt(availableMana) : BigInt(0);
      const manaFormatted = utils.formatUnits(manaValue.toString(), 8);
      
      // Estimate required mana (roughly 1 KOIN = 10^8 mana units, transaction needs ~0.1-0.5 mana typically)
      const estimatedManaNeeded = BigInt(50000000); // ~0.5 mana should be enough for approve + burn
      
      if (manaValue < estimatedManaNeeded) {
        console.log(`\n❌ Insufficient mana to execute transaction.`);
        console.log(`   Available Mana: ${manaFormatted}`);
        console.log(`   Estimated Needed: ~0.5`);
        console.log(`\n   💡 Mana regenerates over time based on your KOIN balance.`);
        console.log(`      Wait a few minutes and try again.`);
        return;
      }
      
      // Calculate amount to burn
      let burnAmount: bigint;
      let burnDescription: string;
      
      if (exactAmount !== undefined) {
        // Exact amount specified
        burnAmount = BigInt(Math.floor(exactAmount * 1e8));
        burnDescription = `${exactAmount} KOIN (exact)`;
        
        if (burnAmount > currentBalance) {
          console.log(`\n❌ Insufficient KOIN balance.`);
          console.log(`   Requested: ${exactAmount} KOIN`);
          console.log(`   Available: ${currentFormatted} KOIN`);
          return;
        }
      } else {
        // Percentage specified
        burnAmount = (currentBalance * BigInt(Math.floor(percent! * 100))) / BigInt(10000);
        burnDescription = `${percent}%`;
      }
      
      const remainingAmount = currentBalance - burnAmount;
      
      const burnFormatted = utils.formatUnits(burnAmount.toString(), 8);
      const remainingFormatted = utils.formatUnits(remainingAmount.toString(), 8);
      
      // Get current VHP balance (before burn)
      const vhp = new Contract({
        id: vhpContract,
        abi: tokenAbi,
        provider,
      });
      const { result: oldVhpResult } = await vhp.functions.balance_of({ owner: wallet.address });
      const oldVhpBalance = oldVhpResult?.value ? utils.formatUnits(oldVhpResult.value, 8) : '0';
      
      console.log('\n🔥 KOIN Burn Summary:');
      console.log(`   Address: ${wallet.address}`);
      console.log(`   Current KOIN Balance: ${currentFormatted} KOIN`);
      console.log(`   Current VHP Balance: ${oldVhpBalance} VHP`);
      console.log(`   Amount to Burn (${burnDescription}): ${burnFormatted} KOIN`);
      console.log(`   Remaining after Burn: ${remainingFormatted} KOIN`);
      console.log(`   Available Mana: ${manaFormatted}`);
      console.log(`   VHP will be credited to the same address.`);
      
      // Check current allowance for PoB contract (spender)
      let currentAllowance = BigInt(0);
      try {
        const { result: allowanceResult } = await koin.functions.allowance({
          owner: wallet.address,
          spender: pobContract,
        });
        currentAllowance = allowanceResult?.value ? BigInt(allowanceResult.value) : BigInt(0);
      } catch (e: any) {
        // No allowance set yet - this is normal, just means we need to approve
        currentAllowance = BigInt(0);
      }
      const allowanceFormatted = utils.formatUnits(currentAllowance.toString(), 8);
      
      console.log(`\n📋 Current Allowance for PoB Contract: ${allowanceFormatted} KOIN`);
      
      const needsApproval = currentAllowance < burnAmount;
      
      if (needsApproval) {
        console.log(`   ⚠️  Insufficient allowance. Need to approve ${burnFormatted} KOIN for PoB contract.`);
      } else {
        console.log(`   ✅ Sufficient allowance for burn.`);
      }
      
      // Get the PoB (Proof of Burn) contract - this is what actually converts KOIN to VHP
      const pob = new Contract({
        id: pobContract,
        abi: pobAbi,
        provider,
        signer,
      });
      
      // Build operations
      const operations: { name: string; operation: any }[] = [];
      
      // Add approval operation if needed - approve PoB contract to spend KOIN
      if (needsApproval) {
        const { operation: approveOp } = await koin.functions.approve({
          owner: wallet.address,
          spender: pobContract,
          value: burnAmount.toString(),
        }, { onlyOperation: true });
        operations.push({ name: 'approve', operation: approveOp });
      }
      
      // Add burn operation via PoB contract (this burns KOIN and mints VHP)
      const { operation: burnOp } = await pob.functions.burn({
        token_amount: burnAmount.toString(),
        burn_address: wallet.address,
        vhp_address: wallet.address,
      }, { onlyOperation: true });
      operations.push({ name: 'burn (PoB)', operation: burnOp });
      
      // Create transaction manually to inspect before signing
      // Use 10% of available mana as RC limit (should be plenty for approve + burn)
      const rcLimit = (manaValue * BigInt(10)) / BigInt(100);
      const transaction = new Transaction({
        signer,
        provider,
        options: {
          rcLimit: rcLimit.toString(),
        },
      });
      
      // Push all operations
      for (const op of operations) {
        await transaction.pushOperation(op.operation);
      }
      await transaction.prepare();
      if (!assertPreparedTransactionNetwork(context, transaction)) return;
      
      // Show transaction details before signing
      console.log('\n📝 Transaction Details (BEFORE SIGNING):');
      console.log('─'.repeat(50));
      console.log(`   Transaction ID: ${transaction.transaction.id}`);
      console.log(`   Payer: ${transaction.transaction.header?.payer}`);
      console.log(`   Payee: ${transaction.transaction.header?.payee || '(none)'}`);
      console.log(`   Nonce: ${transaction.transaction.header?.nonce}`);
      console.log(`   RC Limit: ${transaction.transaction.header?.rc_limit}`);
      console.log(`   Chain ID: ${transaction.transaction.header?.chain_id}`);
      console.log(`\n   Operations (${operations.length}):`);
      transaction.transaction.operations?.forEach((op, i) => {
        const opName = operations[i]?.name || 'unknown';
        console.log(`   [${i + 1}] ${opName.toUpperCase()}`);
        console.log(`       Contract: ${op.call_contract?.contract_id}`);
        console.log(`       Entry Point: ${op.call_contract?.entry_point}`);
        console.log(`       Args (base64): ${op.call_contract?.args}`);
      });
      console.log('─'.repeat(50));
      
      // Decoded operation details
      console.log('\n   Decoded Operations:');
      if (needsApproval) {
        console.log(`   1. APPROVE:`);
        console.log(`       Owner: ${wallet.address}`);
        console.log(`       Spender: ${pobContract} (PoB Contract)`);
        console.log(`       Amount: ${burnFormatted} KOIN`);
      }
      console.log(`   ${needsApproval ? '2' : '1'}. BURN (via PoB Contract):`);
      console.log(`       Contract: ${pobContract} (Proof of Burn)`);
      console.log(`       Token Amount: ${burnFormatted} KOIN`);
      console.log(`       Burn Address: ${wallet.address}`);
      console.log(`       VHP Address: ${wallet.address}`);
      console.log('─'.repeat(50));
      
      if (options.dryRun) {
        console.log('\n📋 Dry run - transaction NOT signed or submitted.');
        return;
      }
      
      if (!options.yes) {
        // Confirm with user
        console.log('\n⚠️  This action is IRREVERSIBLE!');
        const confirm = readlineSync.question('   Type "BURN" to confirm and sign: ');

        if (confirm !== 'BURN') {
          console.log('\n❌ Transaction cancelled.');
          return;
        }
      }
      
      console.log('\n   Signing and submitting transaction...\n');
      
      // Sign and send
      await transaction.sign();
      const receipt = await transaction.send();
      
      console.log('✅ Burn transaction submitted!');
      console.log(`   Transaction ID: ${transaction.transaction.id}`);
      
      if (receipt) {
        if (receipt.logs && receipt.logs.length > 0) {
          console.log('   Logs:', receipt.logs);
        }
        if (receipt.events && receipt.events.length > 0) {
          console.log(`   Events: ${receipt.events.length} event(s)`);
        }
      }
      
      // Wait for transaction to be mined
      console.log('\n⏳ Waiting for transaction to be included in a block...');
      try {
        const blockInfo = await transaction.wait('byTransactionId', 60000);
        console.log(`   ✅ Transaction confirmed in block ${blockInfo?.blockNumber || 'unknown'}`);
      } catch (waitError: any) {
        console.log(`   ⚠️  Could not confirm transaction (timeout). Balances may not be updated yet.`);
      }
      
      // Get new balances
      const { result: newKoinResult } = await koin.functions.balance_of({ owner: wallet.address });
      const newKoinBalance = newKoinResult?.value ? utils.formatUnits(newKoinResult.value, 8) : '0';
      
      const { result: newVhpResult } = await vhp.functions.balance_of({ owner: wallet.address });
      const newVhpBalance = newVhpResult?.value ? utils.formatUnits(newVhpResult.value, 8) : '0';
      
      console.log('\n📊 Balance Comparison:');
      console.log('   ┌────────────┬───────────────────────┬───────────────────────┐');
      console.log('   │ Token      │ Before                │ After                 │');
      console.log('   ├────────────┼───────────────────────┼───────────────────────┤');
      console.log(`   │ KOIN       │ ${currentFormatted.padEnd(21)} │ ${newKoinBalance.padEnd(21)} │`);
      console.log(`   │ VHP        │ ${oldVhpBalance.padEnd(21)} │ ${newVhpBalance.padEnd(21)} │`);
      console.log('   └────────────┴───────────────────────┴───────────────────────┘');
      
    } catch (error: any) {
      console.error('\n❌ Error burning KOIN:');
      if (error.message) {
        console.error(`   Message: ${error.message}`);
      }
      if (error.code) {
        console.error(`   Code: ${error.code}`);
      }
      if (error.logs && error.logs.length > 0) {
        console.error(`   Logs: ${JSON.stringify(error.logs)}`);
      }
      if (error.receipt) {
        console.error(`   Receipt: ${JSON.stringify(error.receipt, null, 2)}`);
      }
      // Full error for debugging
      console.error(`   Full error: ${JSON.stringify(error)}`);
    }
  });

// Testnet information
program
  .command('testnet-info')
  .description('Show official Koinos Foundation testnet connection details')
  .action(() => {
    const testnet = NETWORKS.testnet;
    console.log('\n🧪 Koinos Foundation Testnet:');
    console.log(`   JSON-RPC: ${testnet.rpc}`);
    console.log(`   Health: ${testnet.healthUrl}`);
    console.log(`   Chain ID: ${testnet.chainId}`);
    console.log(`   KOIN Contract: ${testnet.contracts.koin}`);
    console.log(`   VHP Contract: ${testnet.contracts.vhp}`);
    console.log(`   PoB Contract: ${testnet.contracts.pob}`);
    console.log(`   Faucet: ${testnet.faucetUrl}`);
    console.log('\n   Faucet command in Telegram:');
    console.log('   /faucet YOUR_KOINOS_ADDRESS');
    console.log('\n   Note: the testnet can reset; do not use it for production funds or durable state.');
  });

program
  .command('faucet-info')
  .description('Show testnet faucet instructions')
  .action(() => {
    const testnet = NETWORKS.testnet;
    console.log('\n🚰 Testnet Faucet:');
    console.log(`   Open: ${testnet.faucetUrl}`);
    console.log('   Send: /faucet YOUR_KOINOS_ADDRESS');
  });

// Config command
program
  .command('config')
  .description('View or set configuration options')
  .option('--default-account <address>', 'Set the default account address')
  .option('--main-producer-address <address>', 'Set the main producer address used by register-producer-key')
  .option('--network <network>', `Set the default network (${getSupportedNetworkNames()})`)
  .option('--rpc <url>', 'Set the default RPC endpoint URL')
  .option('--show', 'Show current configuration')
  .action(async (options: { defaultAccount?: string; mainProducerAddress?: string; network?: string; rpc?: string; show?: boolean }) => {
    const config = loadConfig();
    const globalOpts = program.opts<{ network?: string; rpc?: string }>();
    const networkOption = options.network || globalOpts.network;
    const rpcOption = options.rpc || globalOpts.rpc;
    
    if (options.defaultAccount) {
      config.defaultAccount = options.defaultAccount;
      saveConfig(config);
      console.log(`\n✅ Default account set to: ${options.defaultAccount}`);
      return;
    }

    if (options.mainProducerAddress) {
      if (!utils.isChecksumAddress(options.mainProducerAddress)) {
        console.log('\n❌ Invalid main producer address format.');
        return;
      }
      config.mainProducerAddress = options.mainProducerAddress;
      saveConfig(config);
      console.log(`\n✅ Main producer address set to: ${options.mainProducerAddress}`);
      return;
    }

    if (networkOption) {
      const networkName = normalizeNetworkName(networkOption);
      if (!NETWORKS[networkName]) {
        console.log(`\n❌ Unsupported network "${networkOption}". Supported networks: ${getSupportedNetworkNames()}`);
        return;
      }
      config.network = networkName;
      config.rpc = NETWORKS[networkName].rpc;
      saveConfig(config);
      console.log(`\n✅ Default network set to: ${networkName}`);
      console.log(`   RPC: ${config.rpc || NETWORKS[networkName].rpc}`);
      return;
    }

    if (rpcOption) {
      config.rpc = rpcOption;
      saveConfig(config);
      console.log(`\n✅ Default RPC set to: ${rpcOption}`);
      return;
    }
    
    if (options.show || (!options.defaultAccount && !options.mainProducerAddress && !networkOption && !rpcOption)) {
      const networkName = normalizeNetworkName(config.network);
      const network = NETWORKS[networkName];
      console.log('\n⚙️  Current Configuration:');
      console.log(`   Config file: ${CONFIG_FILE}`);
      console.log(`   Network: ${networkName}${network ? ` (${network.label})` : ' (unsupported)'}`);
      console.log(`   Default Account: ${config.defaultAccount || '(not set)'}`);
      console.log(`   Main Producer Address: ${config.mainProducerAddress || '(not set)'}`);
      console.log(`   RPC: ${config.rpc || network?.rpc || DEFAULT_RPC}`);
    }
  });

registerVortexCommands(program);
registerMultisigCommands(program);
program.parse();
