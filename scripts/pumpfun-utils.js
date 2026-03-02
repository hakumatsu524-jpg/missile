/**
 * PumpFun Utility Functions
 * 
 * Helper functions for interacting with PumpFun's bonding curve and API
 */

import { PublicKey } from '@solana/web3.js';

// PumpFun Constants
export const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMPFUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJtGU4Bqj39');

// Bonding curve parameters
export const VIRTUAL_SOL_RESERVES = 30 * 1e9; // 30 SOL in lamports
export const VIRTUAL_TOKEN_RESERVES = 1073000000 * 1e6; // ~1.073B tokens
export const TOTAL_SUPPLY = 1000000000 * 1e6; // 1B tokens

/**
 * Calculate tokens out for a given SOL input using bonding curve formula
 */
export function calculateTokensOut(solAmountLamports, currentSolReserves, currentTokenReserves) {
  // k = x * y (constant product)
  const k = BigInt(currentSolReserves) * BigInt(currentTokenReserves);
  const newSolReserves = BigInt(currentSolReserves) + BigInt(solAmountLamports);
  const newTokenReserves = k / newSolReserves;
  const tokensOut = BigInt(currentTokenReserves) - newTokenReserves;
  
  return Number(tokensOut);
}

/**
 * Calculate SOL needed for a given token output
 */
export function calculateSolNeeded(tokenAmount, currentSolReserves, currentTokenReserves) {
  const k = BigInt(currentSolReserves) * BigInt(currentTokenReserves);
  const newTokenReserves = BigInt(currentTokenReserves) - BigInt(tokenAmount);
  const newSolReserves = k / newTokenReserves;
  const solNeeded = newSolReserves - BigInt(currentSolReserves);
  
  return Number(solNeeded);
}

/**
 * Calculate current token price in SOL
 */
export function calculatePrice(solReserves, tokenReserves) {
  return solReserves / tokenReserves;
}

/**
 * Get bonding curve PDA for a token
 */
export function getBondingCurvePDA(mintAddress) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mintAddress).toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Get associated bonding curve token account
 */
export function getBondingCurveTokenAccount(mintAddress) {
  const bondingCurve = getBondingCurvePDA(mintAddress);
  const [tokenAccount] = PublicKey.findProgramAddressSync(
    [
      bondingCurve.toBuffer(),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
      new PublicKey(mintAddress).toBuffer(),
    ],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  );
  return tokenAccount;
}

/**
 * Fetch token data from PumpFun API
 */
export async function fetchPumpFunToken(mintAddress) {
  const response = await fetch(`https://frontend-api.pump.fun/coins/${mintAddress}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch token: ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch recent trades for a token
 */
export async function fetchRecentTrades(mintAddress, limit = 50) {
  const response = await fetch(
    `https://frontend-api.pump.fun/trades/recent?mint=${mintAddress}&limit=${limit}`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch trades: ${response.status}`);
  }
  return response.json();
}

/**
 * Calculate market cap from bonding curve state
 */
export function calculateMarketCap(solReserves, tokenReserves, totalSupply) {
  const price = calculatePrice(solReserves, tokenReserves);
  return price * totalSupply;
}

/**
 * Format SOL amount for display
 */
export function formatSol(lamports) {
  return (lamports / 1e9).toFixed(4);
}

/**
 * Format token amount for display
 */
export function formatTokens(amount, decimals = 6) {
  return (amount / Math.pow(10, decimals)).toLocaleString();
}

/**
 * Calculate price impact for a trade
 */
export function calculatePriceImpact(solAmount, solReserves, tokenReserves) {
  const currentPrice = calculatePrice(solReserves, tokenReserves);
  const tokensOut = calculateTokensOut(solAmount, solReserves, tokenReserves);
  const effectivePrice = solAmount / tokensOut;
  const priceImpact = ((effectivePrice - currentPrice) / currentPrice) * 100;
  
  return {
    currentPrice,
    effectivePrice,
    priceImpact,
    tokensOut,
  };
}

/**
 * Detect if token is trending upward
 * Uses simple moving average crossover
 */
export function detectUptrend(priceHistory, shortPeriod = 5, longPeriod = 20) {
  if (priceHistory.length < longPeriod) {
    return { isUptrend: false, confidence: 0 };
  }
  
  // Calculate short-term SMA
  const shortSMA = priceHistory
    .slice(-shortPeriod)
    .reduce((sum, p) => sum + p.price, 0) / shortPeriod;
  
  // Calculate long-term SMA
  const longSMA = priceHistory
    .slice(-longPeriod)
    .reduce((sum, p) => sum + p.price, 0) / longPeriod;
  
  // Calculate momentum
  const momentum = (shortSMA - longSMA) / longSMA * 100;
  
  return {
    isUptrend: shortSMA > longSMA,
    shortSMA,
    longSMA,
    momentum,
    confidence: Math.min(Math.abs(momentum) / 10, 1), // 0-1 confidence score
  };
}

/**
 * Calculate optimal buyback amount based on price momentum
 */
export function calculateOptimalBuyback(feeBalance, momentum, minBuyback = 0.01, maxBuyback = 1.0) {
  // Higher momentum = larger buyback percentage
  const momentumFactor = Math.min(Math.abs(momentum) / 20, 1); // Cap at 20% momentum
  const buybackPercent = 0.5 + (momentumFactor * 0.4); // 50-90% based on momentum
  
  let buybackAmount = feeBalance * buybackPercent;
  
  // Apply limits
  buybackAmount = Math.max(buybackAmount, minBuyback);
  buybackAmount = Math.min(buybackAmount, maxBuyback, feeBalance);
  
  return {
    amount: buybackAmount,
    percentage: (buybackAmount / feeBalance) * 100,
    momentumFactor,
  };
}

console.log('✅ PumpFun utilities loaded');
