#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.12"
# dependencies = [
# "requests",
# ]
# ///


import requests
import xml.etree.ElementTree as ET

# Test the SMAPI endpoints
# BASE_URL = "https://reitunes.reillywood.com/api"
BASE_URL = "http://localhost:5000"

def test_get_session_id():
    """Test the getSessionId endpoint"""
    soap_request = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <getSessionId/>
    </soap:Body>
</soap:Envelope>"""
    
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://www.sonos.com/Services/1.1#getSessionId"'
    }
    
    response = requests.post(f"{BASE_URL}/smapi/v1/soap", data=soap_request, headers=headers)
    print(f"getSessionId Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    return response.status_code == 200

def test_get_metadata_root():
    """Test the getMetadata endpoint for root"""
    soap_request = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <getMetadata>
            <id>root</id>
            <index>0</index>
            <count>100</count>
        </getMetadata>
    </soap:Body>
</soap:Envelope>"""
    
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://www.sonos.com/Services/1.1#getMetadata"'
    }
    
    response = requests.post(f"{BASE_URL}/smapi/v1/soap", data=soap_request, headers=headers)
    print(f"getMetadata (root) Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    return response.status_code == 200

def test_get_metadata_empty():
    """Test the getMetadata endpoint with empty ID (what Sonos might send)"""
    soap_request = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <getMetadata>
            <id></id>
            <index>0</index>
            <count>100</count>
        </getMetadata>
    </soap:Body>
</soap:Envelope>"""
    
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://www.sonos.com/Services/1.1#getMetadata"'
    }
    
    response = requests.post(f"{BASE_URL}/smapi/v1/soap", data=soap_request, headers=headers)
    print(f"getMetadata (empty) Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    return response.status_code == 200

def test_get_metadata_artists():
    """Test the getMetadata endpoint for artists"""
    soap_request = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <getMetadata>
            <id>artists</id>
            <index>0</index>
            <count>10</count>
        </getMetadata>
    </soap:Body>
</soap:Envelope>"""
    
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://www.sonos.com/Services/1.1#getMetadata"'
    }
    
    response = requests.post(f"{BASE_URL}/smapi/v1/soap", data=soap_request, headers=headers)
    print(f"getMetadata (artists) Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    return response.status_code == 200

def test_get_last_update():
    """Test the getLastUpdate endpoint"""
    soap_request = """<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
    <soap:Body>
        <getLastUpdate/>
    </soap:Body>
</soap:Envelope>"""
    
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://www.sonos.com/Services/1.1#getLastUpdate"'
    }
    
    response = requests.post(f"{BASE_URL}/smapi/v1/soap", data=soap_request, headers=headers)
    print(f"getLastUpdate Status Code: {response.status_code}")
    print(f"Response: {response.text}")
    return response.status_code == 200

if __name__ == "__main__":
    print("Testing SMAPI endpoints...")
    
    try:
        print("\n1. Testing getSessionId...")
        test_get_session_id()
        
        print("\n2. Testing getMetadata (root)...")
        test_get_metadata_root()
        
        print("\n3. Testing getMetadata (empty)...")
        test_get_metadata_empty()
        
        print("\n4. Testing getMetadata (artists)...")
        test_get_metadata_artists()
        
        print("\n5. Testing getLastUpdate...")
        test_get_last_update()
        
    except requests.exceptions.ConnectionError:
        print("Error: Could not connect to server. Make sure the server is running on localhost:5000")
    except Exception as e:
        print(f"Error: {e}")