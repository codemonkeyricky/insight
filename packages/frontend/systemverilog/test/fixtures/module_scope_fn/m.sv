module m;
  function int h();
    return 0;
  endfunction
  class C;
    function void run();
      void'(h());
    endfunction
  endclass
endmodule
