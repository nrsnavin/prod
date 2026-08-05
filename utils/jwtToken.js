// NOTE: the token is returned in the JSON body as well as the httpOnly
// cookie, and that is load-bearing — both Flutter clients read
// `body.token`, persist it, and replay it as a `Cookie:` header on every
// request (see flu/src/core/api_client.dart). They throw "No token
// returned" without it, so this must not be "hardened" away. The web app
// ignores the body copy and rides the httpOnly cookie.
const sendToken = (user, statusCode, res) => {
    const token = user.getJwtToken();
  
    // Options for cookies
    const options = {
      expires: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      httpOnly: true,
      sameSite: "none",
      secure: true,
    };
  
    res.status(statusCode).cookie("token", token, options).json({
      success: true,
      user,
      token,
    });
  };
  
  module.exports = sendToken;