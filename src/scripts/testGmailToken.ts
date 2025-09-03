import { getTokenForUser } from "../utils/googleTokens";
import axios from "axios";

async function testGmailToken() {
  const userId = 2;
  
  try {
    console.log('🔍 Getting token for user', userId);
    const tokenData = await getTokenForUser(userId);
    
    console.log('📄 Database scopes:', tokenData.scopes);
    console.log('🔑 Access token (first 20 chars):', tokenData.access_token.substring(0, 20) + '...');
    
    // Test the token with Google's tokeninfo endpoint
    console.log('\n🌐 Checking token with Google tokeninfo...');
    const tokenInfoResponse = await axios.get(
      `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${tokenData.access_token}`
    );
    
    console.log('📋 Google tokeninfo response:');
    console.log('- Scope:', tokenInfoResponse.data.scope);
    console.log('- Expires in:', tokenInfoResponse.data.expires_in, 'seconds');
    console.log('- Email:', tokenInfoResponse.data.email);
    
    // Check if Gmail scopes are present
    const googleScopes = tokenInfoResponse.data.scope.split(' ');
    const requiredScopes = [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.labels'
    ];
    
    console.log('\n✅ Required Gmail scopes check:');
    requiredScopes.forEach(scope => {
      const hasScope = googleScopes.includes(scope);
      console.log(`- ${scope}: ${hasScope ? '✅' : '❌'}`);
    });
    
    // Test Gmail API call
    console.log('\n📧 Testing Gmail API access...');
    try {
      const gmailResponse = await axios.get(
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`
          }
        }
      );
      console.log('✅ Gmail API accessible. Email:', gmailResponse.data.emailAddress);
    } catch (gmailError: any) {
      console.error('❌ Gmail API error:', gmailError.response?.status, gmailError.response?.data);
    }
    
  } catch (error) {
    console.error('❌ Error testing Gmail token:', error);
  }
}

testGmailToken().then(() => {
  console.log('\n🏁 Test completed');
  process.exit(0);
}).catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});

// Run the test if called directly
if (require.main === module) {
  testGmailToken();
}

export { testGmailToken };