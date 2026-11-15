cmake_minimum_required(VERSION 3.20)
project(demo CXX)

find_package(Threads REQUIRED)
find_package(GTest 1.12 CONFIG REQUIRED)
FetchContent_Declare(fmt GIT_REPOSITORY https://github.com/fmtlib/fmt.git GIT_TAG 10.2.1)
FetchContent_Declare(zlibng URL https://example.com/zlib-ng.tar.gz URL_HASH SHA256=abc123)

add_subdirectory(lib)
add_subdirectory(tests)

add_library(demo::shapes ALIAS shapes)
add_executable(app app/main.cc)
target_link_libraries(app PRIVATE demo::shapes Threads::Threads -pthread m)
