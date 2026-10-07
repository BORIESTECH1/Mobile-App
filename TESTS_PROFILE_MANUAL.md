Profile page manual test checklist

Purpose
- Verify accessibility improvements, initials avatar fallback, file picker UX, and client-side validation work as expected.

Setup
- Open `profile.html` in a browser.
- If testing Save flows, ensure localStorage has `loggedInUser` set to a test username (e.g., in browser console: localStorage.setItem('loggedInUser','tester')).
- Optionally create a profile for the user in localStorage under `bt_profiles` to test avatar persistence.

Manual Test Steps

1) Initials avatar fallback
- Preconditions: remove any stored avatar for the test user (delete `bt_profiles[tester].avatar` or remove profile).
- Reload `profile.html`.
- Expected: hero avatar and topbar user avatar display initials generated from the display name (or 'US' for 'User'). The avatar should be a colored rounded square.

2) Choose image and preview
- Click "Choose image" and select a valid image file.
- Expected: the hero avatar preview updates immediately to the selected image. "Upload & Save" button becomes enabled.

3) Upload & Save
- With a file selected, click "Upload & Save".
- Expected: your existing `window.setProfilePictureFromFile` is invoked; if successful, the preview remains and the button becomes disabled.

4) Remove avatar
- Click "Remove".
- Expected: stored avatar is removed from localStorage and avatar falls back to initials.

5) BVN validation
- Enter fewer than 11 digits into BVN and blur the input.
- Expected: inline error message "BVN must be exactly 11 digits" appears, the field gains a red error state, and screen readers will be notified (aria-live).
- Enter exactly 11 digits and blur; error should clear.

6) Email validation
- Enter an invalid email (e.g., 'foo@') and blur.
- Expected: inline error message appears and aria-live announces it.

7) Phone validation
- Enter an invalid phone (e.g., '123') and blur.
- Expected: inline error message appears and aria-live announces it.

8) Prevent Save on invalid inputs
- Populate BVN with <11 digits or invalid email/phone, then click "Save Profile".
- Expected: Save is prevented, first invalid field is focused, and a message is announced via aria-live.

9) Update topbar userDisplay after Save
- Change "Full name" in the form and click "Save Profile" with valid inputs.
- Expected: Topbar `userDisplay` text updates to the new display name immediately.

Notes
- The manual checks above assume your existing `window.saveProfile`, `window.loadProfile`, and `window.setProfilePictureFromFile` functions behave as expected.
- For automated unit tests, a small harness (Jest or Playwright) would be useful; this project currently contains only static assets so manual tests are provided.

If you want, I can add a tiny automated test harness using plain JS + a headless runner (Playwright) and a package.json with scripts — tell me if you'd prefer that and I will scaffold it.
