module.exports = function validateUrl(url) {
  try {
    const parsed = new URL(url);

    const allowedHosts = [
      "www.youtube.com",
      "youtube.com",
      "youtu.be",
      "www.instagram.com",
      "instagram.com",
      "www.facebook.com",
      "facebook.com",
      "fb.watch"
    ];

    return allowedHosts.includes(parsed.hostname);
  } catch (err) {
    return false;
  }
};
