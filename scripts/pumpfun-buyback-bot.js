/**
 * PumpFun Buyback Bot
 * 
 * This bot monitors PumpFun token charts for upward price movement,
 * collects creator fees, and performs buybacks when conditions are met.
 * 
 * Requirements:
 * - Node.js 18+
 * - Solana wallet with SOL for transactions
 * - PumpFun creator wallet (to collect fees)
 * 
 * Environment Variables:
 * - SOLANA_RPC_URL: Your Solana RPC endpoint
 * - CREATOR_PRIVATE_KEY: Base58 encoded private key of the creator wallet
 * - TOKEN_MINT_ADDRESS: The PumpFun token mint address to monitor
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

// ============ CONFIGURATION ============
const CONFIG = {
  // RPC endpoint (use a private RPC for production)
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  
  // Your token's mint address on PumpFun
  tokenMintAddress: process.env.TOKEN_MINT_ADDRESS || '',
  
  // Creator wallet private key (base58 encoded)
  creatorPrivateKey: process.env.CREATOR_PRIVATE_KEY || '',
  
  // PumpFun program ID
  pumpFunProgramId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  
  // Monitoring settings
  priceCheckIntervalMs: 10000, // Check price every 10 seconds
  priceIncreaseThresholdPercent: 5, // Trigger buyback after 5% increase
  priceWindowMinutes: 5, // Look at price change over last 5 minutes
  
  // Buyback settings
  minFeeBalanceForBuyback: 0.01, // Minimum SOL fees to trigger buyback
  buybackPercentage: 80, // Use 80% of collected fees for buyback
  slippageBps: 500, // 5% slippage tolerance
};

// ============ STATE ============
const state = {
  priceHistory: [],
  lastBuybackTime: null,
  totalBuybacks: 0,
  totalFeesCollected: 0,
};

// ============ SOLANA CONNECTION ============
let connection;
let creatorKeypair;

function initializeSolana() {
  console.log('🔗 Initializing Solana connection...');
  
  connection = new Connection(CONFIG.rpcUrl, 'confirmed');
  
  if (CONFIG.creatorPrivateKey) {
    try {
      const secretKey = bs58.decode(CONFIG.creatorPrivateKey);
      creatorKeypair = Keypair.fromSecretKey(secretKey);
      console.log(`✅ Creator wallet loaded: ${creatorKeypair.publicKey.toBase58()}`);
    } catch (error) {
      console.error('❌ Failed to load creator wallet:', error.message);
      process.exit(1);
    }
  } else {
    console.warn('⚠️ No creator private key provided - running in read-only mode');
  }
}

// ============ PUMPFUN API FUNCTIONS ============

/**
 * Fetch current token price from PumpFun
 */
async function fetchTokenPrice(mintAddress) {
  try {
    const response = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    const data = await response.json();
    
    return {
      price: data.usd_market_cap / data.total_supply,
      marketCap: data.usd_market_cap,
      virtualSolReserves: data.virtual_sol_reserves,
      virtualTokenReserves: data.virtual_token_reserves,
      bondingCurve: data.bonding_curve,
      complete: data.complete,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('❌ Failed to fetch token price:', error.message);
    return null;
  }
}

/**
 * Fetch creator fee balance from PumpFun bonding curve
 */
async function fetchCreatorFeeBalance(mintAddress) {
  try {
    // Get the bonding curve PDA for the token
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mintAddress).toBuffer()],
      CONFIG.pumpFunProgramId
    );
    
    // Fetch account info to get fee balance
    const accountInfo = await connection.getAccountInfo(bondingCurvePda);
    
    if (!accountInfo) {
      console.log('⚠️ Bonding curve account not found');
      return 0;
    }
    
    // Parse the bonding curve data to extract creator fees
    // Note: This is a simplified version - actual parsing depends on PumpFun's account structure
    const data = accountInfo.data;
    
    // Creator fees are typically stored at a specific offset in the account data
    // This offset may vary - check PumpFun's IDL for exact structure
    const creatorFees = data.readBigUInt64LE(72) / BigInt(1e9); // Convert lamports to SOL
    
    return Number(creatorFees);
  } catch (error) {
    console.error('❌ Failed to fetch creator fee balance:', error.message);
    return 0;
  }
}

/**
 * Collect accumulated creator fees from PumpFun
 */
async function collectCreatorFees(mintAddress) {
  if (!creatorKeypair) {
    console.log('⚠️ Cannot collect fees - no creator wallet configured');
    return null;
  }
  
  try {
    console.log('💰 Collecting creator fees...');
    
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mintAddress).toBuffer()],
      CONFIG.pumpFunProgramId
    );
    
    // Build the collect fees instruction
    // Note: This is a simplified representation - actual instruction structure depends on PumpFun's IDL
    const collectFeesIx = {
      programId: CONFIG.pumpFunProgramId,
      keys: [
        { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
        { pubkey: creatorKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(mintAddress), isSigner: false, isWritable: false },
      ],
      data: Buffer.from([/* collect_fees instruction discriminator */]),
    };
    
    const transaction = new Transaction().add(collectFeesIx);
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [creatorKeypair],
      { commitment: 'confirmed' }
    );
    
    console.log(`✅ Fees collected! Signature: ${signature}`);
    return signature;
  } catch (error) {
    console.error('❌ Failed to collect creator fees:', error.message);
    return null;
  }
}

/**
 * Execute a buyback using PumpFun's swap functionality
 */
async function executeBuyback(mintAddress, solAmount) {
  if (!creatorKeypair) {
    console.log('⚠️ Cannot execute buyback - no creator wallet configured');
    return null;
  }
  
  try {
    console.log(`🛒 Executing buyback with ${solAmount.toFixed(4)} SOL...`);
    
    // Calculate minimum tokens out with slippage
    const priceData = await fetchTokenPrice(mintAddress);
    if (!priceData) {
      throw new Error('Failed to fetch current price');
    }
    
    // Use bonding curve formula to calculate expected tokens
    const virtualSolReserves = priceData.virtualSolReserves;
    const virtualTokenReserves = priceData.virtualTokenReserves;
    
    // k = x * y (constant product formula)
    const k = virtualSolReserves * virtualTokenReserves;
    const newSolReserves = virtualSolReserves + solAmount * 1e9;
    const newTokenReserves = k / newSolReserves;
    const tokensOut = virtualTokenReserves - newTokenReserves;
    
    // Apply slippage
    const minTokensOut = tokensOut * (1 - CONFIG.slippageBps / 10000);
    
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), new PublicKey(mintAddress).toBuffer()],
      CONFIG.pumpFunProgramId
    );
    
    // Build the buy instruction
    // Note: This is simplified - actual instruction depends on PumpFun's IDL
    const buyIx = {
      programId: CONFIG.pumpFunProgramId,
      keys: [
        { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
        { pubkey: creatorKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(mintAddress), isSigner: false, isWritable: false },
        // ... additional accounts for token transfers
      ],
      data: Buffer.from([
        /* buy instruction discriminator + amount + min_tokens_out */
      ]),
    };
    
    const transaction = new Transaction().add(buyIx);
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = creatorKeypair.publicKey;
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [creatorKeypair],
      { commitment: 'confirmed' }
    );
    
    console.log(`✅ Buyback executed! Signature: ${signature}`);
    console.log(`   Spent: ${solAmount.toFixed(4)} SOL`);
    console.log(`   Received: ~${(tokensOut / 1e6).toFixed(2)} tokens`);
    
    state.totalBuybacks++;
    state.lastBuybackTime = Date.now();
    
    return signature;
  } catch (error) {
    console.error('❌ Failed to execute buyback:', error.message);
    return null;
  }
}

// ============ PRICE MONITORING ============

/**
 * Calculate price change percentage over the configured window
 */
function calculatePriceChange() {
  const now = Date.now();
  const windowMs = CONFIG.priceWindowMinutes * 60 * 1000;
  
  // Filter prices within the window
  const recentPrices = state.priceHistory.filter(
    (p) => now - p.timestamp <= windowMs
  );
  
  if (recentPrices.length < 2) {
    return null;
  }
  
  const oldestPrice = recentPrices[0].price;
  const latestPrice = recentPrices[recentPrices.length - 1].price;
  
  const changePercent = ((latestPrice - oldestPrice) / oldestPrice) * 100;
  
  return {
    oldestPrice,
    latestPrice,
    changePercent,
    windowMinutes: CONFIG.priceWindowMinutes,
  };
}

/**
 * Check if buyback conditions are met
 */
function shouldExecuteBuyback(priceChange, feeBalance) {
  // Check if price is going up
  if (!priceChange || priceChange.changePercent < CONFIG.priceIncreaseThresholdPercent) {
    return false;
  }
  
  // Check if we have enough fees
  if (feeBalance < CONFIG.minFeeBalanceForBuyback) {
    return false;
  }
  
  // Prevent too frequent buybacks (at least 1 minute apart)
  if (state.lastBuybackTime && Date.now() - state.lastBuybackTime < 60000) {
    return false;
  }
  
  return true;
}

// ============ MAIN BOT LOOP ============

async function runBot() {
  console.log('═══════════════════════════════════════════');
  console.log('   🚀 PumpFun Buyback Bot Started');
  console.log('═══════════════════════════════════════════');
  console.log(`📊 Monitoring token: ${CONFIG.tokenMintAddress || 'NOT SET'}`);
  console.log(`⏱️  Check interval: ${CONFIG.priceCheckIntervalMs / 1000}s`);
  console.log(`📈 Price threshold: ${CONFIG.priceIncreaseThresholdPercent}% increase`);
  console.log(`💰 Min fee balance: ${CONFIG.minFeeBalanceForBuyback} SOL`);
  console.log('═══════════════════════════════════════════\n');
  
  if (!CONFIG.tokenMintAddress) {
    console.error('❌ TOKEN_MINT_ADDRESS not set. Please configure the token to monitor.');
    console.log('\nUsage:');
    console.log('  TOKEN_MINT_ADDRESS=<mint> CREATOR_PRIVATE_KEY=<key> node pumpfun-buyback-bot.js');
    process.exit(1);
  }
  
  initializeSolana();
  
  // Main monitoring loop
  while (true) {
    try {
      // Fetch current price
      const priceData = await fetchTokenPrice(CONFIG.tokenMintAddress);
      
      if (priceData) {
        // Update price history
        state.priceHistory.push({
          price: priceData.price,
          timestamp: priceData.timestamp,
        });
        
        // Keep only last 30 minutes of price data
        const cutoffTime = Date.now() - 30 * 60 * 1000;
        state.priceHistory = state.priceHistory.filter((p) => p.timestamp > cutoffTime);
        
        // Calculate price change
        const priceChange = calculatePriceChange();
        
        // Log current status
        console.log(`\n📊 Price Update @ ${new Date().toLocaleTimeString()}`);
        console.log(`   Current Price: $${priceData.price.toFixed(10)}`);
        console.log(`   Market Cap: $${priceData.marketCap.toLocaleString()}`);
        
        if (priceChange) {
          const emoji = priceChange.changePercent >= 0 ? '📈' : '📉';
          console.log(`   ${emoji} ${CONFIG.priceWindowMinutes}min Change: ${priceChange.changePercent.toFixed(2)}%`);
        }
        
        if (priceData.complete) {
          console.log('   ⚠️ Token has graduated from bonding curve');
        }
        
        // Check creator fee balance
        const feeBalance = await fetchCreatorFeeBalance(CONFIG.tokenMintAddress);
        console.log(`   💰 Pending Fees: ${feeBalance.toFixed(4)} SOL`);
        
        // Check if we should execute a buyback
        if (shouldExecuteBuyback(priceChange, feeBalance)) {
          console.log('\n🎯 Buyback conditions met!');
          
          // First, collect the fees
          const collectSig = await collectCreatorFees(CONFIG.tokenMintAddress);
          
          if (collectSig) {
            state.totalFeesCollected += feeBalance;
            
            // Calculate buyback amount
            const buybackAmount = feeBalance * (CONFIG.buybackPercentage / 100);
            
            // Execute the buyback
            await executeBuyback(CONFIG.tokenMintAddress, buybackAmount);
            
            console.log(`\n📊 Bot Statistics:`);
            console.log(`   Total Buybacks: ${state.totalBuybacks}`);
            console.log(`   Total Fees Collected: ${state.totalFeesCollected.toFixed(4)} SOL`);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error in main loop:', error.message);
    }
    
    // Wait before next check
    await new Promise((resolve) => setTimeout(resolve, CONFIG.priceCheckIntervalMs));
  }
}

// ============ GRACEFUL SHUTDOWN ============

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down bot...');
  console.log(`📊 Final Statistics:`);
  console.log(`   Total Buybacks: ${state.totalBuybacks}`);
  console.log(`   Total Fees Collected: ${state.totalFeesCollected.toFixed(4)} SOL`);
  process.exit(0);
});

// ============ START BOT ============

runBot().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
