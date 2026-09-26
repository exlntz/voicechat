# Discord redesign checklist

Manual QA checklist for `redesign/discord-ui`.

- Reference material: public Discord product and design posts at <https://discord.com/blog/>.
- Target: Discord-inspired shell, navigation, and theme cues.
- Non-goal: pixel-exact Discord parity.
- Preview: no deployed preview yet. Run this against a local branch build or an Electron build.
- Environment: use a real session and backend data for this pass. Do not use mocked servers.

## Session and auth

- [ ] Register a new account.
- [ ] Log in with an existing account.
- [ ] Log out.
- [ ] Log back in and confirm no private state from the prior session leaks into the new session.
- [ ] Refresh and confirm the shell restores the expected signed-in or signed-out state.

## Friends, requests, and blocked users

- [ ] Open the Friends view.
- [ ] Send a friend request.
- [ ] Accept, decline, or clear a pending friend request as applicable.
- [ ] Open the blocked users state.
- [ ] Block and unblock a user.

## Direct messages and chat actions

- [ ] Open an existing DM.
- [ ] Start a new DM from the shell.
- [ ] Send a text message.
- [ ] Edit a message.
- [ ] Reply to a message.
- [ ] Pin and unpin a message.
- [ ] Delete a message.
- [ ] Upload supported attachments.
- [ ] Search for a DM with the quick switcher.
- [ ] Change wallpapers and confirm the choice applies to the expected chat surfaces.
- [ ] Verify light theme.
- [ ] Verify dark theme.

## Calls, screen share, and Electron

- [ ] Start or join a call.
- [ ] Start and stop screen share.
- [ ] Verify the solo call state.
- [ ] Verify the docked call state.
- [ ] Verify the Electron shell flow if a packaged build is available.

## Keyboard and focus

- [ ] Open the quick switcher with `Ctrl+K` on Windows/Linux.
- [ ] Open the quick switcher with `Cmd+K` on macOS.
- [ ] Move selection with arrow keys.
- [ ] Activate a selection with `Enter`.
- [ ] Close the quick switcher with `Esc`.
- [ ] Confirm focus returns to a sensible element after close and navigation.

## Responsive widths and motion

- [ ] 360 px width.
- [ ] 390 px width.
- [ ] 768 px width.
- [ ] 860 px width.
- [ ] 861 px width.
- [ ] 1280 px width.
- [ ] 1440 px width.
- [ ] Reduced motion enabled.

## Notes for sign-off

- This checklist tracks flows that still need manual confirmation.
- It does not claim the UI is fully verified.
- It does not claim pixel-exact Discord matching.
