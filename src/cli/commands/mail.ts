import { Command } from "commander";
import { join } from "path";
import { getOctopaiDir } from "../context";
import { Maildir } from "../../mail";

export function registerMailCommands(program: Command): void {
  const mailCmd = program.command("mail").description("View and send mail");

  mailCmd
    .command("inbox")
    .description("List messages in inbox")
    .option("-n, --count <n>", "Number of messages to show", "10")
    .option("-a, --all", "Show all messages including read")
    .action(async (options) => {
      const octopaiDir = getOctopaiDir();
      const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

      const messages = await inbox.list("new");
      const curMessages = await inbox.list("cur");

      let allMessages = [...messages, ...curMessages];
      if (!options.all) {
        allMessages = [
          ...messages,
          ...curMessages.slice(0, Math.max(0, parseInt(options.count, 10) - messages.length)),
        ];
      }
      allMessages = allMessages.slice(0, parseInt(options.count, 10));

      if (allMessages.length === 0) {
        console.log("Inbox is empty.");
        return;
      }

      console.log("Inbox:");
      console.log("");
      for (const msg of allMessages) {
        const flag = msg.flags.seen ? " " : "*";
        const date = msg.date.toLocaleDateString();
        const shortId = msg.id.slice(0, 8);
        console.log(`  ${flag} ${shortId}  ${date}  ${msg.subject}`);
      }
      console.log("");
      console.log("Use 'octopai mail read <id>' to read a message (id can be partial)");
    });

  mailCmd
    .command("send <message>")
    .description("Send a message to the brain")
    .option("-s, --subject <subject>", "Message subject")
    .action(async (message, options) => {
      const octopaiDir = getOctopaiDir();
      const sent = new Maildir(join(octopaiDir, "mail", "sent"));
      await sent.init();

      const subject = options.subject || `New task: ${message.slice(0, 50)}...`;

      await sent.write({
        from: "human@local",
        to: "brain@octopai.local",
        subject,
        date: new Date(),
        body: message,
        headers: {},
      });

      console.log(`Message sent: ${subject}`);
      console.log("The brain will process it on the next poll cycle.");
    });

  mailCmd
    .command("read [id]")
    .description("Read a message (latest if no ID provided)")
    .action(async (id) => {
      const octopaiDir = getOctopaiDir();
      const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

      const messages = [...(await inbox.list("new")), ...(await inbox.list("cur"))];

      if (messages.length === 0) {
        console.log("Inbox is empty.");
        return;
      }

      messages.sort((a, b) => b.date.getTime() - a.date.getTime());

      let msg = null;
      if (id) {
        msg = messages.find((m) => m.id.startsWith(id));
      } else {
        msg = messages[0];
      }

      if (!msg) {
        if (id) {
          console.log(`Message not found: ${id}`);
        }
        console.log("");
        console.log("Available messages:");
        for (const m of messages.slice(0, 5)) {
          console.log(`  ${m.id.slice(0, 8)}  ${m.subject.slice(0, 50)}`);
        }
        return;
      }

      const stripTerminalArtifacts = (text: string) =>
        text
          .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
          .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
          .replace(/\x1B\[[\d;]*[A-Za-z]/g, "")
          .replace(/\x1B[PX^_].*?\x1B\\/g, "")
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
          .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g, "")
          .replace(/[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯]/g, "")
          .replace(/[◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯]/g, "")
          .replace(/[⊙⊚⊛⊜⊝⊞⊟⊠⊡▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◂◃◄◅◆◇]/g, "")
          .replace(/[\u2800-\u28FF]/g, "")
          .replace(/[←↑→↓↔↕↖↗↘↙↚↛↜↝↞↟↠↡↢↣↤↥↦↧↨↩↪↫↬↭↮↯↰↱↲↳↴↵↶↷↸↹↺↻↼↽↾↿⇀⇁⇂⇃⇄⇅⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏⇐⇑⇒⇓⇔⇕⇖⇗⇘⇙⇚⇛⇜⇝⇞⇟⇠⇡⇢⇣⇤⇥⇦⇧⇨⇩⇪]/g, "")
          .replace(/[—–·•‣⁃◦]/g, "")
          .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, "")
          .replace(/['']{2,}/g, "")
          .replace(/[""]{2,}/g, "")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      console.log(`ID: ${msg.id}`);
      console.log(`From: ${msg.from}`);
      console.log(`To: ${msg.to}`);
      console.log(`Subject: ${stripTerminalArtifacts(msg.subject)}`);
      console.log(`Date: ${msg.date.toLocaleString()}`);
      console.log(`---`);
      console.log(stripTerminalArtifacts(msg.body));

      if (!msg.flags.seen) {
        await inbox.markSeen(msg.id);
      }
    });
}
