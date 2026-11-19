# The Line Stays

English transcript and credits for the 5:59 Lattice-web-ui setup film, recorded for [v0.4.5](https://github.com/lattice-writer/lattice-web-ui/releases/tag/v0.4.5).

## Transcript

**0:00 · Not saved yet**

This line isn't saved yet. The caret is still blinking inside the last word. Close the phone, and the screen goes away. So where does the line go?

**0:14 · The room**

The draft stays in this browser. The saved project lives somewhere else. That desk can go dark. The Linux machine stays on. It keeps the saved files, runs LaTeX, and answers whenever another screen opens the workspace. So the setup starts here.

**0:39 · The kit**

Open the project's releases page and take version 0.4.5. There are two downloads: a plugin ZIP for the Mac, and a source kit for Linux. Check both against the published checksums. There's no prebuilt server; you build it here. Run the build script, unpack the host archive it leaves, and step inside.

**1:08 · The service**

The host has to join your tailnet before anyone else can find it. Then one installer command turns the build into a service for your project. The Tailscale option keeps it private, on HTTPS, for devices your tailnet authorizes. Ask tailscale serve status, and it prints the address.

**1:36 · Two doors**

That address is the private door. A phone without the VPN can't use it. For that phone, the operator sets up a second, public HTTPS address with device pairing. It's optional, it's separate, and the private command never creates it.

**2:00 · The shortcut**

On your own Mac, Lattice can carry a shortcut to that address. In Settings, under Plugins, install the ZIP from its URL and turn the plugin on. From the command palette, set the workspace address once. After that, Open remote workspace takes you back to the host.

**2:26 · Another desk**

A second Mac needs nothing installed from the host. It opens the same HTTPS address in its own browser, with its own session. The project list comes from the host, so the same files are waiting. Save an edit here. The other desk can now open the same words.

**2:51 · An icon**

To keep it close, give it an icon. In Safari, choose File, then Add to Dock, and confirm. Click the icon, and the workspace opens in a window of its own. Safari copies your sign-in when you add it; after that, the app keeps its own.

**3:15 · Two minutes**

Now the phone. On the owner's session, open Remote devices and choose Pair a device. The invitation works once, and only for two minutes. Scan it with the camera, or send the one-time link. If that phone goes missing, revoke it on its own; the others keep working.

**3:41 · A name**

On the phone, give it a name you'll recognize, and connect this device. The browser opens a project served by the host. Return with the same browser and it remembers you. No token on the screen, and no VPN on the phone.

**4:04 · Home Screen**

To make it feel like an app, use Safari's Share menu. Choose Add to Home Screen, leave Open as Web App on, and add it. With compact tabs, Share sits under More. Tap the new icon, and it goes straight to the editor.

**4:28 · The host blinks**

Here's the harder test. The host restarts while the phone is open. For a moment the page has nothing to show. Then it reloads, and the paired session is still there. The saved project stayed on Linux. The phone found its way back.

**4:51 · The hinge**

Back to the line from the start. On the folded cover, the editor fills the screen, and the caret sits at line three, column forty-nine. Open it. The editor stays, and the PDF takes the other half. Close it again. Same line, same column, still unsaved. The screen changed twice. The line didn't move.

**5:24 · The host stays**

The host stays where it is, building and serving. Today it runs 0.4.5, and an optional check can say when a newer release exists. It won't update itself; you rebuild when you choose. Everything else is a screen that knows the address.

## Film credits

The workspace footage comes from Lattice-web-ui 0.4.5. The native plugin settings were recorded with 0.4.1, which uses the same install controls. The Safari installation steps are illustrated, the installed Mac window was captured in Chrome, and the phone layouts use emulated viewports. The iPhone Duo sequence follows the same unsaved draft through one fold, unfold, and refold.

Claude Opus 5.5 directed the screenplay and reviewed the edit. The English narration uses Kokoro. The music and sound effects were made for the film.

The following models were adapted for the film under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

- [MacBook Pro M3, 16-inch](https://sketchfab.com/3d-models/macbook-pro-m3-16-inch-2024-8e34fc2b303144f78490007d91ff57c4) by Jack Baeten. The lid was animated and the screen fitted with a workspace recording.
- [Server Racking System](https://sketchfab.com/3d-models/server-racking-system-6fe2cacf836b4aed96c650b286db5486) by wpanayides. The rack was scaled, lit, and staged for the host shots.
- [iPhone Duo](https://github.com/mgwalkerjr95/iphone-duo-cad) by mgwalkerjr95. The hinge was animated and the screens fitted with recordings.
- [iPhone 18 Pro Max](https://www.xemstudio.com/objects/iphone-18-pro-max/) by Xem Studio. The materials and display were adapted for the phone shots.

The room uses [Wooden Table 01](https://polyhaven.com/a/WoodenTable_01) by Ethan Place, [Wooden Chair 01](https://polyhaven.com/a/WoodenChair_01), [Desk Lamp Arm 01](https://polyhaven.com/a/desk_lamp_arm_01), and [Small Workshop](https://polyhaven.com/a/small_workshop) by Dimitrios Savva and Jarod Guest, from [Poly Haven’s CC0 library](https://polyhaven.com/license).
