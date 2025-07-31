export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Environment variables validation with detailed logging
  const CLOVER_AUTH_TOKEN = process.env.CLOVER_AUTH_TOKEN;
  const CLOVER_MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  
  console.log('Environment check:', {
    hasAuthToken: !!CLOVER_AUTH_TOKEN,
    authTokenLength: CLOVER_AUTH_TOKEN?.length,
    authTokenStart: CLOVER_AUTH_TOKEN?.substring(0, 8) + '...',
    hasMerchantId: !!CLOVER_MERCHANT_ID,
    merchantId: CLOVER_MERCHANT_ID
  });
  
  if (!CLOVER_AUTH_TOKEN || !CLOVER_MERCHANT_ID) {
    return res.status(500).json({ 
      error: 'Server configuration error',
      details: 'Missing Clover credentials'
    });
  }

  try {
    const { amount, coupon, customerData } = req.body;
    
    console.log('Request body:', { amount, coupon, customerData });
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount provided' });
    }

    // First, let's test basic API connectivity with a simple request
    const testResponse = await testCloverConnection();
    console.log('Connection test result:', testResponse);
    
    if (!testResponse.success) {
      return res.status(500).json({
        error: 'Clover API connection failed',
        details: testResponse.error,
        statusCode: testResponse.statusCode
      });
    }

    // Coupon validation
    const coupons = [
      { code: 'SAVE10', type: 'percentage', value: 10, active: true },
      { code: 'SAVE20', type: 'percentage', value: 20, active: true },
      { code: 'SAVE50', type: 'percentage', value: 50, active: true }
    ];

    let discountAmount = 0;
    let appliedCoupon = null;
    
    if (coupon) {
      const foundCoupon = coupons.find(c => c.code === coupon && c.active);
      if (foundCoupon) {
        discountAmount = Math.round((amount * foundCoupon.value) / 100);
        appliedCoupon = foundCoupon;
      }
    }

    const finalAmount = Math.max(0, amount - discountAmount);

    // Create Clover hosted checkout session
    const cloverResponse = await createHostedCheckoutSession({
      amount: finalAmount,
      originalAmount: amount,
      discountAmount,
      coupon: appliedCoupon,
      customerData: customerData || {}
    });

    if (!cloverResponse.success) {
      return res.status(cloverResponse.statusCode || 500).json({ 
        error: 'Payment processing failed',
        details: cloverResponse.error,
        retryAfter: cloverResponse.retryAfter
      });
    }

    return res.status(200).json({
      checkoutUrl: cloverResponse.checkoutUrl,
      originalAmount: amount,
      discountAmount,
      finalAmount,
      couponApplied: appliedCoupon?.code || null,
      sessionId: cloverResponse.sessionId
    });

  } catch (error) {
    console.error('Checkout processing error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}

// Test basic Clover API connectivity
async function testCloverConnection() {
  const CLOVER_AUTH_TOKEN = process.env.CLOVER_AUTH_TOKEN;
  const CLOVER_MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  
  // Test with a simple merchant info request first
  const TEST_URL = `https://api.clover.com/v3/merchants/${CLOVER_MERCHANT_ID}`;
  
  try {
    console.log('Testing connection to:', TEST_URL);
    
    const response = await fetch(TEST_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CLOVER_AUTH_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    
    console.log('Test response status:', response.status);
    console.log('Test response headers:', {
      contentType: response.headers.get('content-type'),
      remaining: response.headers.get('X-RateLimit-Remaining'),
      limit: response.headers.get('X-RateLimit-Limit'),
      reset: response.headers.get('X-RateLimit-Reset')
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('Merchant info received:', {
        id: data.id,
        name: data.name,
        country: data.country
      });
      return { success: true, data };
    } else {
      const errorText = await response.text();
      console.log('Test request failed:', errorText);
      return { 
        success: false, 
        error: `HTTP ${response.status}: ${errorText}`,
        statusCode: response.status
      };
    }
    
  } catch (error) {
    console.error('Connection test error:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// Enhanced function with comprehensive retry and backoff logic
async function createHostedCheckoutSession({ amount, originalAmount, discountAmount, coupon, customerData }) {
  const CLOVER_AUTH_TOKEN = process.env.CLOVER_AUTH_TOKEN;
  const CLOVER_MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;
  
  // Production URL
  const HOSTED_CHECKOUT_URL = 'https://api.clover.com/invoicingcheckoutservice/v1/checkouts';

  try {
    const lineItemName = coupon 
      ? `Order (${coupon.code} applied - $${discountAmount} off)` 
      : 'Order';

    const checkoutPayload = {
      customer: {
        email: customerData.email || 'customer@example.com',
        firstName: customerData.name?.split(' ')[0] || 'Customer',
        lastName: customerData.name?.split(' ').slice(1).join(' ') || 'User'
      },
      shoppingCart: {
        lineItems: [
          {
            name: lineItemName,
            price: amount * 100, // In cents
            unitQty: 1,
            note: coupon ? `Original: $${originalAmount}, Discount: $${discountAmount}` : 'Online order'
          }
        ]
      }
    };

    console.log('Checkout payload:', JSON.stringify(checkoutPayload, null, 2));
    console.log('Making request to:', HOSTED_CHECKOUT_URL);

    // Make API request with enhanced retry logic
    const result = await makeRequestWithRetry(HOSTED_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOVER_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Clover-Merchant-Id': CLOVER_MERCHANT_ID,
        'User-Agent': 'CloverCheckout/1.0',
        'X-Request-ID': generateRequestId()
      },
      body: JSON.stringify(checkoutPayload)
    });

    return {
      success: true,
      checkoutUrl: result.href,
      sessionId: result.checkoutSessionId
    };

  } catch (error) {
    console.error('Clover Hosted Checkout API error:', error);
    
    // Return structured error response
    if (error.statusCode === 429) {
      return {
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        statusCode: 429,
        retryAfter: error.retryAfter
      };
    }
    
    return {
      success: false,
      error: error.message,
      statusCode: error.statusCode || 500
    };
  }
}

// Enhanced retry function with better debugging
async function makeRequestWithRetry(url, options, maxRetries = 3, baseDelay = 2000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Making API request (attempt ${attempt + 1}/${maxRetries + 1}) at ${new Date().toISOString()}`);
      console.log('Request headers:', JSON.stringify(options.headers, null, 2));
      
      // Add a small delay before each request to respect rate limits
      if (attempt > 0) {
        await sleep(1000);
      }
      
      const response = await fetch(url, options);
      
      // Enhanced response logging
      console.log(`Response status: ${response.status}`);
      console.log(`Response statusText: ${response.statusText}`);
      console.log('All response headers:', Object.fromEntries(response.headers.entries()));
      
      // Log rate limit headers specifically
      console.log(`Rate limit headers:`, {
        remaining: response.headers.get('X-RateLimit-Remaining'),
        limit: response.headers.get('X-RateLimit-Limit'),
        reset: response.headers.get('X-RateLimit-Reset'),
        tokenLimit: response.headers.get('X-RateLimit-tokenLimit')
      });
      
      // If successful, return the parsed response
      if (response.ok) {
        const responseData = await response.json();
        console.log('Successful response data:', responseData);
        return responseData;
      }
      
      // Handle 429 specifically with enhanced backoff
      if (response.status === 429) {
        const responseText = await response.text();
        console.log('429 Response body:', responseText);
        
        if (attempt === maxRetries) {
          const error = new Error(`Rate limit exceeded after ${maxRetries + 1} attempts`);
          error.statusCode = 429;
          
          const retryAfter = response.headers.get('Retry-After') || response.headers.get('X-RateLimit-Reset');
          if (retryAfter) {
            error.retryAfter = retryAfter;
          }
          
          throw error;
        }
        
        // Determine wait time from headers
        const retryAfter = response.headers.get('Retry-After');
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');
        let waitTime;
        
        if (retryAfter) {
          if (/^\d+$/.test(retryAfter)) {
            waitTime = parseInt(retryAfter) * 1000;
          } else {
            const retryDate = new Date(retryAfter);
            waitTime = Math.max(0, retryDate.getTime() - Date.now());
          }
        } else if (rateLimitReset) {
          const resetTime = parseInt(rateLimitReset) * 1000;
          waitTime = Math.max(0, resetTime - Date.now());
        } else {
          waitTime = baseDelay * Math.pow(3, attempt) + (Math.random() * 2000);
        }
        
        waitTime = Math.min(waitTime, 60000);
        
        console.log(`Rate limited (429). Waiting ${waitTime}ms before retry (attempt ${attempt + 1})`);
        await sleep(waitTime);
        continue;
      }
      
      // Handle other HTTP errors
      const errorText = await response.text();
      console.log(`Error response body (${response.status}):`, errorText);
      
      const error = new Error(`HTTP ${response.status}: ${errorText}`);
      error.statusCode = response.status;
      
      // Don't retry on client errors (4xx) except 429
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw error;
      }
      
      // Retry server errors (5xx) with backoff
      if (response.status >= 500) {
        if (attempt === maxRetries) {
          throw error;
        }
        const waitTime = baseDelay * Math.pow(2, attempt);
        console.log(`Server error ${response.status}. Retrying in ${waitTime}ms...`);
        await sleep(waitTime);
        continue;
      }
      
      throw error;
      
    } catch (error) {
      lastError = error;
      console.log('Caught error:', error.message, error.name, error.code);
      
      // Only retry for network errors, not application errors
      if (error.name === 'TypeError' || error.message.includes('fetch') || error.code === 'ECONNRESET') {
        if (attempt === maxRetries) {
          throw error;
        }
        const waitTime = baseDelay * Math.pow(2, attempt);
        console.log(`Network error: ${error.message}. Retrying in ${waitTime}ms...`);
        await sleep(waitTime);
        continue;
      }
      
      // For other errors, don't retry
      throw error;
    }
  }
  
  throw lastError;
}

// Utility function for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate unique request ID for tracking
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}