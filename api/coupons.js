export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Available coupon codes (admin-managed)
    const coupons = [
      { 
        code: 'SAVE10', 
        name: 'Save 10%', 
        description: '10% off your order', 
        type: 'percentage', 
        value: 10, 
        active: true 
      },
      { 
        code: 'SAVE20', 
        name: 'Save 20%', 
        description: '20% off your order', 
        type: 'percentage', 
        value: 20, 
        active: true 
      },
      { 
        code: 'SAVE50', 
        name: 'Save 50%', 
        description: '50% off your order', 
        type: 'percentage', 
        value: 50, 
        active: true 
      }
    ];

    // Return only active coupons
    const activeCoupons = coupons.filter(coupon => coupon.active);
    
    return res.status(200).json({
      success: true,
      coupons: activeCoupons,
      count: activeCoupons.length
    });

  } catch (error) {
    console.error('Coupons API error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}