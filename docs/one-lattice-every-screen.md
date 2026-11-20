# One Lattice, Every Screen

English transcript and credits for the 2:13 Lattice-web-ui film, recorded with [v0.9.5](https://github.com/lattice-writer/lattice-web-ui/releases/tag/v0.9.5) on Lattice 0.19.0.

## Transcript

Each scene has a heading and one line of text on screen. The narration follows them.

**0:00 · A paper, open on a phone**

*On screen: Lattice, in a mobile browser.* A typo in the paper is put right on the phone.

**0:05 · This paper just compiled**

This paper just compiled. Not on this phone.

*On screen: One word put right on a phone. A new PDF in 0.3 s.*

**0:08 · It compiled on the host**

It compiled here: a Linux machine with no screen of its own. Lattice's own release runs on it, behind a small gateway.

*On screen: The phone only shows what happens there. The host's terminal shows the two runs, 0.20 s and 0.10 s.*

**0:18 · Everything lives on the host**

Your projects, your TeX and your agents live on this machine. A screen only brings a browser.

**0:25 · Two ways in**

There are two ways in. On your tailnet, Tailscale tells the gateway who is asking.

*On screen: On your tailnet it just opens. From the internet the gateway asks first.*

**0:32 · On your tailnet, it just opens**

If it is you, Lattice just opens.

*On screen: Tailscale tells the gateway who is asking. No password, no token.*

**0:37 · From the internet, the gateway asks first**

From outside your tailnet the door is optional, and it asks: the owner's token, or a pairing code.

*On screen: An optional door, for a screen that is not on your tailnet.*

**0:44 · You let a new screen in yourself**

You let a new screen in yourself, from Lattice's Settings. The code works once, for two minutes.

*On screen: Settings, then Phone and app, then Pair a device.*

**0:52 · The screen names itself, and it is in**

The screen names itself, and it is in.

*On screen: It stays paired until you revoke it.*

**0:57 · On a computer: all of Lattice, in a browser tab**

On a computer you get the real Lattice in a browser tab: the editor, the PDF, every project on the host.

*On screen: Nothing to install. The work stays on the host.*

**1:08 · The agent works on the host, too**

The agent works on the host, too.

*On screen: Asked for one sentence, it edits the paper where the paper lives.*

**1:17 · On a phone, it folds into one panel**

On a phone the same Lattice folds into a single panel,

*On screen: The same Lattice, the same project.*

**1:21 · Every view becomes a tab**

and every view becomes a tab.

*On screen: Source, PDF, files, the agent and your papers.*

**1:30 · The screen you turn to takes the workspace**

It is one writer's workspace. Turn to another screen, and that screen takes it over.

*On screen: One writer, one workspace: one screen has it at a time. Each hand-over takes 0.7 s.*

**1:42 · Lend a screen, and take it back**

Lend a screen and take it back: revoke it, and it is out at once.

*On screen: Paired screens are listed in Settings, each with its Revoke. The revoked screen is out after 0.2 s.*

**1:51 · One click updates the host**

When a new release is out, Lattice says so. One click updates the host.

*On screen: No shell and no SSH: the notice is in Lattice itself. The host goes from 0.9.4 to 0.9.5.*

**1:59 · One Lattice, on one machine**

One Lattice, on one machine. Open it from every screen you own.

## What is recorded, and what stands in

- Every product picture is a screen recording of Lattice 0.19.0 behind Lattice-web-ui 0.9.5, on a demo host with a sample paper. The update scene starts on 0.9.4 and is a real update.
- The phone and the tablet are Chromium windows of those sizes with touch input, not devices.
- `workspace.example.ts.net` is a placeholder address and `you@github` a placeholder name. On the demo host a stand-in supplies the identity that Tailscale Serve supplies on a tailnet. One take is real Tailscale from end to end: the address typed on the computer, and Lattice opening with no sign-in. The film's own label covers the machine's tailnet name in it.
- The agent's turn is a real one: Claude Code, run by Lattice on the host. A usage meter in its panel is covered.
- The times are read from the recordings: 0.3 s for the build, 0.7 s each way for a hand-over between two computers, and 0.2 s for a revoked screen to be out. Between a computer and a phone a hand-over takes longer.
- In the update scene, a delay of 25 ms each way stands in for a screen that is not on the host itself.
- Waits are cut in four places, none of them inside a time the film states: after Settings opens, while another project loads, before the click back in the hand-over, and between the agent's answer and the rebuilt paper.
- The countdown on the pairing code is drawn by the film. The code and the screen that uses it were recorded in two takes.
- The first scene puts a typo right. Most later recordings start from the paper before that fix, so the old spelling can be found in a few wide shots.

## Film credits

Claude Fable 5.2 directed, recorded, edited and rendered the film. The English narration uses Kokoro. The sound effects were synthesised for the film, and there is no music. The type is [Hanken Grotesk](https://fonts.google.com/specimen/Hanken+Grotesk), under the SIL Open Font License.
