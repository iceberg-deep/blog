---
layout: post
title: "The Cookie That Came Back to Life"
subtitle: "HTB Celestial, where a Node app reads your name tag as a spell and a root cron politely runs your homework"
date: 2018-09-01 12:00:00 +0000
description: "A Node.js app trusts a cookie enough to run it, and a root cron job trusts a file enough to execute it. Two acts of misplaced faith and you walk to root."
image: /assets/og/the-cookie-that-came-back-to-life.png
tags: [hackthebox, writeup]
---

Celestial is a box about trusting a piece of paper too much. A single Node.js app hands you a cookie, a little base64 packet that holds your name and your hometown, and then makes the one mistake that ends careers: when the cookie comes back, the server does not just read it, it rebuilds it. It takes the text you stored and turns it back into a living object. And if you wrote that object cleverly enough, the act of bringing it back to life runs your code. Then, once you are inside as a low user, a clock on the wall does the rest. Every five minutes root walks past your desk, picks up a script you left lying there, and runs it without reading it. Two doors, both held open by the same habit, which is mistaking a label for an instruction and then trusting it anyway.

```
        C E L E S T I A L
        =================
        cookie:  {"username":"Dummy", ... }    a name tag
                 you scribble a spell on the back
                        |
                        v
        the server doesn't read the tag. it REBUILDS it.
        bringing it back to life chants the spell out loud.
                        |
                        v
        shell as sun. then a root cron, every 5 minutes,
        runs a file you own without ever looking at it.
                                                    魂
```

## 0x01 · the lonely port

`nmap` comes back almost embarrassed by how little it has to say. One service, sitting high.

```
PORT     STATE SERVICE VERSION
3000/tcp open  http    Node.js Express framework
```

Port 3000 is the default home of an Express app, the most common skeleton a Node web service wears. Browse to it cold and the page just sulks at you with a bare `<h1>404</h1>`. That blank stare is the first tell. The app is not deciding what to show you based on the URL. It is deciding based on something you are carrying, and right now you are carrying nothing. Send the request through a proxy so you can see the full conversation, and there it is in the response headers, a cookie the server insists on handing you.

## 0x02 · the name tag you can rewrite

The cookie is named `profile`, and it looks like line noise until you recognize the shape of base64 and decode it.

```
$ echo 'eyJ1c2VybmFtZSI6IkR1bW15Iiwi...' | base64 -d
{"username":"Dummy","country":"Idk Probably Somewhere Dumb","city":"Lametown","num":"2"}
```

So the cookie is just a small JSON record, your profile, kept on your side and mailed back with every request. Tamper with it to prove the server reads it. Change `num` to something and reload, and the page greets you with a little arithmetic joke, `Hey Dummy 2 + 2 is 22`, doing string math on a value you control. That is the whole confession right there. The server is taking your cookie, turning the stored text back into a real object it can poke at, and acting on the result. The fancy word for turning stored text back into a live object is deserialization. Think of it like a flat-pack chair. You did not mail the server a chair, you mailed it the instructions and the parts, and the server builds the chair on arrival. The danger is in what happens if your flat-pack box says, somewhere in the assembly steps, also set the house on fire.

## 0x03 · the spell on the back of the tag

This Express app builds the chair using a library called `node-serialize`, and `node-serialize` has a flaw that is almost too on-the-nose. When it serializes a JavaScript object, it has to handle functions, since plain JSON cannot. So it stores a function as a string with a special marker glued to the front, `_$$ND_FUNC$$_`. And when it reads that marker back during `unserialize()`, it faithfully turns the string back into a real function using `eval`. By itself a rebuilt function just sits there, defined but never called. The trick is to make it call itself the instant it is born. You append two characters to the end, `()`, which in JavaScript means run this right now. A function that invokes itself the moment it is defined is called an immediately invoked function expression, an IIFE. Picture a jack-in-the-box. Mailing a wound-up jack-in-the-box is harmless until someone opens the lid, and the `()` is the spring that pops the lid the same second the box is unpacked. The server opens the box for you.

So you forge a `profile` cookie whose value is an object with a function field, marked for `node-serialize` and rigged to fire on arrival. The classic generator for the Node payload is `nodejsshell.py`, which spits out a reverse shell encoded as a parade of character codes so no awkward quotes break the JSON. You drop that into the function body and wrap the whole thing so it self-executes.

```
{"iceberg":"_$$ND_FUNC$$_function(){ [ nodejs reverse shell to 10.10.14.4:443, encoded via String.fromCharCode ] }()"}
```

I am describing the shell rather than printing a live one, and that restraint is the point. A working reverse shell is a loaded gun, and a copy-pasteable one in a blog is a loaded gun left on a park bench. The `String.fromCharCode(...)` wrapper exists purely to smuggle the payload past JSON's quoting rules, the same way you would spell a word out loud, letter by letter, to get it past a bad phone line. Base64 the finished object, paste it back as your `profile` cookie, start a listener, and send one request.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from celestial [10.10.10.85]
$ id
uid=1000(sun) gid=1000(sun) groups=1000(sun),24(cdrom),27(sudo)...
```

The server rebuilt your cookie, the lid popped, and the spell ran as the user the app runs as. That is `sun`, and `user.txt` is sitting in their home.

```
sun@celestial:~$ cat /home/sun/Documents/user.txt
████████████████████████████████
```

## 0x04 · the clock that does your chores

`sun` is not root, and `sudo -l` asks for a password you do not have, so the climb has to come from something the box does on its own. The fastest way to catch a machine in the act is to watch its processes from the outside, without needing root to read the cron tables. `pspy` does exactly that, polling the process list so quickly that short-lived commands cannot hide.

```
sun@celestial:~$ ./pspy64
...
CMD: UID=0  python /home/sun/Documents/script.py > /home/sun/output.txt
CMD: UID=0  cp /root/script.py /home/sun/Documents/script.py
CMD: UID=0  chown sun:sun /home/sun/Documents/script.py
```

Read those three lines slowly, because they are the whole privilege escalation. `UID=0` is root. Every five minutes root runs `python /home/sun/Documents/script.py`, a file that lives in `sun`'s own directory, which means `sun` can write to it. Then root tidies up after itself, copying a clean copy back from `/root/script.py` and handing ownership back to `sun`, even resetting the timestamp so nothing looks disturbed. The cleanup is what makes it survivable as a CTF, but it is also the flaw in plain sight. There is a window, between when root runs your file and when it restores the pristine one, where the thing root is about to execute is a file you fully control.

## 0x05 · handing root your homework

The exploit is not an exploit at all. You just edit the script. Overwrite `/home/sun/Documents/script.py` with your own Python, wait at most five minutes, and root runs it as root.

```
sun@celestial:~/Documents$ cat > script.py <<'EOF'
import os
os.system(" [ python reverse shell to 10.10.14.4:443 ] ")
EOF
```

Then start a second listener and let the clock come around.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from celestial [10.10.10.85]
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

No memory corruption, no CVE, no race you have to win on the third try. A scheduled job ran a file at root privilege that a non-root user was allowed to rewrite. That is the entire second half of the box. Think of it like a teacher who grades whatever is in your folder at 3pm without checking that you are the one who wrote it. Slip a different page into the folder and the teacher grades that one, with full authority, no questions asked.

## 0x06 · the honest caveat

It is easy to file Celestial under beginner box and move on, but both halves are mistakes that ship in real software constantly, just dressed in plainer clothes. The deserialization bug is the one that should keep people up at night. The rule it breaks is simple and absolute. Data that came from a stranger should never be rebuilt into something that can run. A cookie, a session blob, a serialized object in a message queue, a cached Java or Python or PHP structure, these are all the same envelope, and the moment your code reconstructs the contents into live functionality instead of inert values, you have handed the sender a lever connected to your machinery. `node-serialize` is just one library that forgot to draw that line, but the family is enormous, and it has eaten production systems far less polite than this box.

The cron is the quieter lesson, and arguably the more common one in the wild. Nothing was unpatched. No version number was wrong. A root job simply executed a file that a lower-privileged user could write, which collapses the whole point of having privilege levels at all. The fix is boring and total, which is that anything root runs on a schedule must live where only root can touch it, end to end, the script and every directory above it. Permissions are not paperwork. They are the only thing standing between trust the user and trust the user with root's hands. Two doors on this box, and both of them were unlocked from the inside by someone who trusted a thing they should have inspected.

## 0x07 · outro

```
the server read your name tag and built whatever you wrote.
you wrote a spell, and bringing it to life cast it.

then a clock came around, picked up your page,
        and graded it with root's red pen, never asking who wrote it.

never rebuild a stranger's words into something that can run.
never let a lower hand write what a higher hand will execute. wear black.

                                                            EOF
```

---

*HTB: Celestial, retired 25 Aug 2018. An easy Linux box that is really a lecture on trusting serialized input, wearing a Node.js cookie for a costume, with a root cron for an encore. The jack-in-the-box still pops in a lab and nowhere you don't own.*