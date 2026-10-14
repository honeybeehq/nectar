from flask import Flask

app = Flask(__name__)


@app.get("/")
def index():
    return "<!doctype html><title>Flask fixture</title><h1>Hello from the Nectar Flask fixture</h1>"
