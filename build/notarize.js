const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") return;

  const appleId       = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId        = process.env.APPLE_TEAM_ID;

  if (!appleId || !applePassword || !teamId) {
    console.log("Skipping notarization - missing env vars (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = appOutDir + "/" + appName + ".app";

  console.log("Notarizing " + appName + "...");

  await notarize({
    appPath: appPath,
    appleId: appleId,
    appleIdPassword: applePassword,
    teamId: teamId
  });

  console.log("Notarization complete for " + appName);
};
