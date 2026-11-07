cmake_minimum_required(VERSION 3.20)
project(shapes_demo CXX)

add_subdirectory(lib)

add_executable(app app/main.cc)
target_link_libraries(app PRIVATE shapes Threads::Threads)
