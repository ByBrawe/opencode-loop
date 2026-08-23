# Current Loop + Goal coexistence canary

This branch intentionally re-runs the original dedicated-Goal overlap scenario against the released pair:

- OpenCode Loop 0.5.35
- OpenCode Goal 1.3.26
- current OpenCode CLI from npm

The older coexistence run used Loop 0.5.34-era code and Goal 1.3.25, so its provider-cancel/command-bridge behavior is not treated as evidence for the current releases.

The canary starts a real `/goal`, holds its first provider turn open, issues `/loop devam et` in the same OpenCode session, and verifies that Loop refuses to persist or dispatch a prompt job while the dedicated Goal owns continuation.

This is a regression probe, not a production behavior change.
