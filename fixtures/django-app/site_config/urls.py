from django.http import HttpResponse
from django.urls import path


def index(request):
    return HttpResponse("<!doctype html><title>Django fixture</title><h1>Hello from the Nectar Django fixture</h1>")


urlpatterns = [path("", index)]
