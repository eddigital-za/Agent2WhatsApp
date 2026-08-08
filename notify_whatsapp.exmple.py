#!/usr/bin/env python3
"""
notify_whatsapp.py

Simple helper to POST a summary message to the local Agent2WhatsApp microservice.

Usage:
  python notify_whatsapp.py --phone 96891126867 --text "Your message here"

The script will try to use `requests` if available, falling back to Python's
`urllib` if not. It does not run automatically — run it locally on your machine.
"""
import argparse
import json
import sys
from urllib import request as urllib_request

try:
    import requests
except Exception:
    requests = None
    
                # 968 => the cuntery key 
DEFAULT_PHONE = "968xxxxxxxx"
DEFAULT_TEXT = (
    "🤖 *Agent Task Completed!*"
    "*Summary of work:* Updated hero spacing in index.html — header top padding set to 200px "
    "with responsive adjustments for tablet and mobile."
)


def send_via_requests(url, payload):
    resp = requests.post(url, json=payload, timeout=10)
    resp.raise_for_status()
    return resp


def send_via_urllib(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib_request.urlopen(req, timeout=10) as resp:
        return resp.read(), resp.getcode()


def main():
    parser = argparse.ArgumentParser(description="Send a POST to the local Agent2WhatsApp /send endpoint")
    parser.add_argument("--phone", default=DEFAULT_PHONE, help="Destination phone number (digits only, include country code)")
    parser.add_argument("--text", default=DEFAULT_TEXT, help="Message text to send (WhatsApp formatting supported)")
    parser.add_argument("--url", default="http://localhost:4000/send", help="Endpoint URL for the microservice")
    args = parser.parse_args()

    payload = {"phone": args.phone, "text": args.text}
    print(f"Sending to {args.url} -> {args.phone}")

    if requests:
        try:
            r = send_via_requests(args.url, payload)
            print("Success:", getattr(r, "status_code", "OK"))
            print(r.text if hasattr(r, "text") else "")
            return 0
        except Exception as e:
            print("Failed with requests:", e)
            return 1
    else:
        try:
            body, code = send_via_urllib(args.url, payload)
            print("Success:", code)
            print(body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body)
            return 0
        except Exception as e:
            print("Failed:", e)
            return 1


if __name__ == "__main__":
    sys.exit(main())
