const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  const appPath = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".app"
  );

  console.log("Stripping extended attributes from " + appPath);

  try { execSync('dot_clean "' + appPath + '"', { stdio: "inherit" }); } catch (e) {}
  try { execSync('xattr -cr "' + appPath + '"', { stdio: "inherit" }); } catch (e) {}
  try { execSync('find "' + appPath + '" -exec xattr -d com.apple.FinderInfo {} \\; 2>/dev/null || true', { stdio: "inherit", shell: true }); } catch (e) {}
  try { execSync('find "' + appPath + '" -exec xattr -d com.apple.quarantine {} \\; 2>/dev/null || true', { stdio: "inherit", shell: true }); } catch (e) {}

  var cleanPath = appPath + "-clean";
  try {
    execSync('ditto --norsrc "' + appPath + '" "' + cleanPath + '"', { stdio: "inherit" });
    execSync('rm -rf "' + appPath + '"', { stdio: "inherit" });
    execSync('mv "' + cleanPath + '" "' + appPath + '"', { stdio: "inherit" });
    console.log("Clean copy created with ditto --norsrc");
  } catch (e) {
    console.log("ditto clean copy failed:", e.message);
  }

  console.log("Extended attributes stripped");
};
