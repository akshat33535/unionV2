import { ethers } from 'ethers';
import { 
  CHAINS, 
  RPC_URLS, 
  RPC_FALLBACKS, 
  UNION_CONTRACT, 
  TOKENS, 
  GAS_SETTINGS, 
  RPC_TIMEOUTS, 
  TRANSACTION_SETTINGS 
} from './config.js';

const providerCache = new Map();

const debugLog = (message, data = {}) => {
  const timestamp = new Date().toISOString();
  const safeData = {
    ...data,
    ...(data.value ? { value: data.value.toString() } : {}),
    ...(data.amount ? { amount: data.amount.toString() } : {})
  };
  console.log(`[${timestamp}] DEBUG: ${message}`, JSON.stringify(safeData, null, 2));
};

const getGasParams = async (provider, overrideSettings = {}) => {
  try {
    const feeData = await provider.getFeeData();
    const calculatedParams = {
      maxFeePerGas: overrideSettings.maxFeePerGas || 
                   (feeData.maxFeePerGas * 125n / 100n) || 
                   ethers.parseUnits("20", "gwei"),
      maxPriorityFeePerGas: overrideSettings.maxPriorityFeePerGas || 
                          (feeData.maxPriorityFeePerGas * 125n / 100n) || 
                          ethers.parseUnits("15", "gwei"),
      gasLimit: overrideSettings.gasLimit || 500000
    };

    debugLog("Calculated gas parameters", {
      maxFeeGwei: ethers.formatUnits(calculatedParams.maxFeePerGas, "gwei"),
      maxPriorityGwei: ethers.formatUnits(calculatedParams.maxPriorityFeePerGas, "gwei"),
      gasLimit: calculatedParams.gasLimit
    });

    return calculatedParams;
  } catch (error) {
    debugLog("Failed to get dynamic gas params, using defaults", { error: error.message });
    return {
      maxFeePerGas: ethers.parseUnits("20", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("15", "gwei"),
      gasLimit: 500000
    };
  }
};

export const getProvider = async (chainId) => {
  if (!providerCache.has(chainId)) {
    const endpoints = [
      RPC_URLS[chainId],
      ...(RPC_FALLBACKS[chainId] || []),
      'https://ethereum-sepolia.publicnode.com'
    ].filter(Boolean);

    for (const url of endpoints) {
      try {
        const provider = new ethers.JsonRpcProvider(url, {
          chainId: Number(CHAINS[chainId]),
          name: chainId.toLowerCase()
        });

        await Promise.race([
          provider.getBlockNumber(),
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error(`RPC timeout after ${RPC_TIMEOUTS.request}ms`));
            }, RPC_TIMEOUTS.request);
          })
        ]);

        debugLog(`Connected to RPC`, { url, chainId });
        providerCache.set(chainId, provider);
        return provider;
      } catch (error) {
        debugLog(`RPC endpoint failed`, { url, error: error.message });
        continue;
      }
    }
    throw new Error(`All RPC endpoints failed for ${chainId}`);
  }
  return providerCache.get(chainId);
};

const executeTransaction = async (contract, method, args, overrides, operationName) => {
  const txResponse = await contract[method](...args, overrides);
  debugLog("Transaction submitted", {
    operation: operationName,
    hash: txResponse.hash,
    gasLimit: txResponse.gasLimit.toString(),
    maxFeePerGas: ethers.formatUnits(txResponse.maxFeePerGas, 'gwei'),
    maxPriorityFeePerGas: ethers.formatUnits(txResponse.maxPriorityFeePerGas, 'gwei')
  });

  const receipt = await txResponse.wait();
  debugLog("Transaction mined", {
    status: receipt.status === 1 ? "success" : "failed",
    confirmations: receipt.confirmations,
    gasUsed: receipt.gasUsed.toString()
  });

  if (receipt.status !== 1) throw new Error("Transaction failed on-chain");
  return receipt;
};

export const sendToken = async ({ 
  sourceChain, 
  destChain, 
  asset, 
  amount, 
  privateKey, 
  gasSettings = {},
  recipient = null,
  referral = null // Added referral parameter as per Union's update
}) => {
  try {
    debugLog("Starting bridge transfer", {
      sourceChain,
      destChain,
      asset,
      amount: amount.toString(),
      recipient,
      referral
    });

    if (!CHAINS[sourceChain] || !CHAINS[destChain]) {
      throw new Error(`Invalid chain configuration: ${sourceChain} → ${destChain}`);
    }
    if (!privateKey?.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error('Invalid private key format (must be 64 hex chars with 0x prefix)');
    }

    const provider = await getProvider(sourceChain);
    const wallet = new ethers.Wallet(privateKey, provider);
    const senderAddress = await wallet.getAddress();
    
    const recipientAddress = recipient 
      ? ethers.getAddress(recipient) 
      : senderAddress;

    const gasParams = await getGasParams(provider, gasSettings);
    const bridgeAddress = UNION_CONTRACT[sourceChain];
    if (!bridgeAddress) throw new Error(`Missing bridge address for ${sourceChain}`);
    
    const isNative = asset === 'native' || asset === 'NATIVE';
    const isWETH = asset === 'WETH';
    const tokenAddress = isNative ? null : 
      (isWETH ? TOKENS.WETH[sourceChain] : asset);

    if (isNative) {
      // Updated interface with referral support
      const bridge = new ethers.Contract(
        bridgeAddress,
        [
          'function depositNative(uint16 destChainId, address recipient, address referral) payable',
          'function depositNative(uint16 destChainId, address recipient) payable' // Fallback
        ],
        wallet
      );

      let tx;
      try {
        // Try with referral first
        tx = await executeTransaction(
          bridge,
          'depositNative',
          [CHAINS[destChain], recipientAddress, referral || ethers.ZeroAddress],
          {
            value: ethers.parseEther(amount.toString()),
            ...gasParams
          },
          'nativeDeposit'
        );
      } catch {
        // Fallback to non-referral version if failed
        tx = await executeTransaction(
          bridge,
          'depositNative',
          [CHAINS[destChain], recipientAddress],
          {
            value: ethers.parseEther(amount.toString()),
            ...gasParams
          },
          'nativeDeposit'
        );
      }
      return tx.hash;
    }

    // ERC20 Token Transfer (including WETH)
    const erc20 = new ethers.Contract(
      tokenAddress,
      [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function decimals() view returns (uint8)'
      ],
      wallet
    );

    const decimals = await erc20.decimals().catch(() => 18);
    const parsedAmount = ethers.parseUnits(amount.toString(), decimals);

    // Check balance
    const balance = await erc20.balanceOf(senderAddress);
    if (balance < parsedAmount) {
      throw new Error(`Insufficient balance. Need ${amount}, has ${ethers.formatUnits(balance, decimals)}`);
    }

    // Handle approval
    const allowance = await erc20.allowance(senderAddress, bridgeAddress);
    if (allowance < parsedAmount) {
      await executeTransaction(
        erc20,
        'approve',
        [bridgeAddress, parsedAmount * 2n],
        {
          ...gasParams,
          gasLimit: isWETH ? 200000 : 100000 // Higher gas for WETH
        },
        'tokenApproval'
      );
    }

    // Updated bridge interface with referral support
    const bridge = new ethers.Contract(
      bridgeAddress,
      [
        'function depositERC20(address token, uint256 amount, uint16 destChainId, address recipient, address referral)',
        'function depositERC20(address token, uint256 amount, uint16 destChainId, address recipient)' // Fallback
      ],
      wallet
    );

    let tx;
    try {
      // Try with referral first
      tx = await executeTransaction(
        bridge,
        'depositERC20',
        [
          tokenAddress, 
          parsedAmount, 
          CHAINS[destChain],
          recipientAddress,
          referral || ethers.ZeroAddress
        ],
        {
          ...gasParams,
          gasLimit: isWETH ? 350000 : 300000 // Higher gas for WETH
        },
        'tokenBridgeTransfer'
      );
    } catch {
      // Fallback to non-referral version
      tx = await executeTransaction(
        bridge,
        'depositERC20',
        [
          tokenAddress, 
          parsedAmount, 
          CHAINS[destChain],
          recipientAddress
        ],
        {
          ...gasParams,
          gasLimit: isWETH ? 350000 : 300000
        },
        'tokenBridgeTransfer'
      );
    }

    return tx.hash;

  } catch (error) {
    debugLog("Bridge transfer failed", {
      error: {
        message: error.message,
        code: error.code,
        stack: error.stack
      },
      troubleshooting: [
        '1. Verify RPC endpoint is responsive',
        '2. Check token balance and approvals',
        '3. Confirm bridge contract is operational',
        '4. Validate chain configurations',
        '5. Check for contract updates from Union Build'
      ]
    });
    throw error;
  }
};
