# Current Loop + Goal coexistence canary

This branch keeps the dedicated-Goal overlap scenario pinned to a known released pair:

- OpenCode Loop 0.5.35
- OpenCode Goal 1.3.27
- current OpenCode CLI from npm

The historical canary first ran with pre-0.5.35 Loop code and Goal 1.3.25, so that output is not used as current-release evidence.

A clean follow-up run with Loop 0.5.35 + Goal 1.3.26 on OpenCode 1.18.21 reproduced the real collision on both Ubuntu and Windows: Loop correctly emitted `goal-overlap-blocked` and persisted no job, but the host slash-command bridge could cancel the in-flight Goal turn and Goal could repin its executor to the Loop command's local agent.

Goal 1.3.27 fixes that command-ownership boundary. This canary installs the published 1.3.27 package from npm and repeats the same real-host overlap scenario. It requires:

- the dedicated Goal to remain active;
- Loop to emit `goal-overlap-blocked`;
- no Loop prompt job to be persisted;
- no autonomous Loop provider request to start;
- no command bridge request to leak to the model;
- Goal execution ownership to remain with the dedicated Goal workflow.

The test is intentionally pinned to an exact companion release so unrelated future Goal releases cannot make ordinary Loop pull requests nondeterministic. Moving-`latest` compatibility belongs in a separate scheduled canary.

This is a regression probe, not a production Loop behavior change.
